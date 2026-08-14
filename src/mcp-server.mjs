import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { dirname, isAbsolute } from "node:path";
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.mjs";
import { createAgent, createTabWithNavigation } from "./agent-browser.mjs";
import { createResilientBridgeRouter } from "./resilient-bridge.mjs";
import {
  launchChromeProfile,
  publicChromeProfileCatalog,
  readChromeProfileCatalog
} from "./chrome-profile-launcher.mjs";
import { injectFilesViaPageFile } from "./file-injection.mjs";
import { savePageAsset } from "./page-asset.mjs";
import { runCuaScrollCapture } from "./scroll-capture.mjs";
import { runScrollAssetCapture, summarizeAssetCaptureManifest } from "./scroll-asset-capture.mjs";
import { TabMutationQueue } from "./tab-mutation-queue.mjs";
import {
  compactNetworkJsonGroups,
  groupNetworkJsonSummaries,
  selectNetworkJsonAssetCandidates,
  summarizeNetworkJsonBody
} from "./network-response.mjs";
import { summarizeNetworkRequestPostData } from "./network-request.mjs";
import { runProfileSelftest } from "./selftest.mjs";
import {
  detectChallenge,
  dismissBenignOverlays,
  solveCheckbox,
  solveSlider,
  SLIDER_VERIFY_DEFAULT as solveSliderVerifyDefault,
  captureChallengeAssets,
  runSolvePipeline,
  buildHandoffMessage,
  VerificationHold,
  createBackendFromEnv
} from "./verification/index.mjs";

const config = await loadConfig();
const router = await createResilientBridgeRouter(config);
const agent = createAgent(router);
const tabMutationQueue = new TabMutationQueue();
const assetCaptureJobs = new Map();
const scrollCaptureJobs = new Map();
const activeAssetCapturePromises = new Map();
const verification = new VerificationHold();
const verificationBackend = createBackendFromEnv(process.env.AGENTOS_VERIFICATION_BACKEND);
const IMPLEMENTATION_VERSION = "0.4.0+codex.20260801130514";
const NETWORK_BODY_RETRY_ERRORS = /(?:No data found|evicted from inspector cache|resource with given identifier)/i;

async function readNetworkResponseBody(profileName, tabId, requestId, target) {
  let lastError;
  for (let attempt = 0; attempt < 21; attempt += 1) {
    try {
      return await router.request(profileName, "cdp.send", {
        tabId,
        cdpMethod: "Network.getResponseBody",
        cdpParams: { requestId },
        cdpOptions: { target }
      });
    } catch (error) {
      lastError = error;
      if (!NETWORK_BODY_RETRY_ERRORS.test(error?.message || String(error)) || attempt === 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

// MCP SDK v1.30.0 — supports server/discover, resultType, and modern protocol
// negotiation automatically. No manual handler changes required for 2026-07-28.
const server = new Server(
  { name: "agentos-chrome-cdp", version: IMPLEMENTATION_VERSION },
  { capabilities: { tools: {} } }
);

const schemas = [
  {
    name: "chrome_profiles",
    description: "List exact connected Chrome profiles. Always select by metadata.profileName.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "chrome_profile_catalog",
    description: "List existing local Google Chrome profiles without launching Chrome. Returns only directory and display names.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "chrome_profile_start",
    description: "Securely bootstrap and start one exact existing local Chrome profile with ordinary Chrome, then wait for that profile's installed extension ID and profileName to register. Never returns the one-use token or secret and never uses remote debugging or copied user data.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string", minLength: 1 },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 }
      },
      required: ["profileName"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_selftest",
    description: "Run tabs and Runtime.evaluate checks inside one exact Chrome profile. If tabId is omitted or names an inaccessible browser-internal page, the plugin creates an about:blank task tab and always closes it before returning.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] }
      },
      required: ["profileName"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_tabs",
    description: "List, get, create, activate, navigate, reload, go back/forward, or close tabs in one exact profile.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        action: { enum: ["list", "get", "new", "activate", "navigate", "reload", "back", "forward", "close"] },
        tabId: { type: ["string", "number"] },
        url: { type: "string" }
      },
      required: ["profileName", "action"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_cdp",
    description: "Send a raw CDP command, read buffered events, or parse Network data as bounded projections in one exact profile. readEvents supports cursor and redacted filters. readResponseJson accepts one requestId; batch/events variants group equivalent response item sets. Response actions accept shapePaths to reveal only safe nested key names/types before selecting known scalar rootFields. readRequestData returns only an allowlisted projection of a request POST body (cursor/count/status/type/scene and related paging fields), plus integrity metadata. Raw bodies stay inside the plugin; URL/token/cookie/header/secret fields are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        action: { enum: ["send", "readEvents", "readResponseJson", "readResponseJsonBatch", "readResponseJsonEvents", "readRequestData"] },
        method: { type: "string" },
        params: {
          type: "object",
          description: "CDP params for send. Response actions accept requestId(s), itemsPath/itemFields/rootFields, and shapePaths for safe nested key/type discovery. readRequestData accepts requestId, fields, and optional maxPostDataBytes."
        },
        options: {
          type: "object",
          properties: {
            afterSequence: { type: "number" },
            limit: { type: "integer", minimum: 1, maximum: 1000 },
            timeoutMs: { type: "number", minimum: 0 },
            methods: { type: "array", items: { type: "string" } },
            methodPrefixes: { type: "array", items: { type: "string" } },
            urlIncludes: { type: "array", items: { type: "string" } },
            target: { type: "object" },
            includeSensitive: { type: "boolean" }
          },
          additionalProperties: false
        },
        target: { type: "object" }
      },
      required: ["profileName", "tabId", "action"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_locator",
    description: "Use the Codex-compatible Playwright locator surface in an exact Chrome profile. For editable form controls, prefer fill/type/press here: these actions scroll first, perform real tab-scoped CDP mouse and keyboard input, and preserve framework input state. Do not replace textContent with Runtime.evaluate for form entry.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        selector: { type: "string" },
        index: { type: "integer", description: "Optional zero-based match index. Use -1 for the last match." },
        action: { enum: ["count", "isVisible", "isEnabled", "innerText", "textContent", "getAttribute", "click", "fill", "type", "press", "check", "uncheck", "selectOption", "waitFor"] },
        value: {},
        options: {
          type: "object",
          description: "Action options. waitFor accepts state and timeoutMs. If a selector matches hidden or duplicate controls, use index to select the intended visible match."
        }
      },
      required: ["profileName", "tabId", "selector", "action"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_history",
    description: "Search Chrome history inside one exact profile.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        queries: { type: "array", items: { type: "string" } },
        from: { type: "string" },
        to: { type: "string" },
        limit: { type: "number" }
      },
      required: ["profileName"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_clipboard",
    description: "Read or write the Chrome profile clipboard through the authorized extension offscreen document.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        action: { enum: ["read", "write", "readItems", "writeItems"] },
        tabId: { type: ["string", "number"] },
        text: { type: "string" },
        items: { type: "array", items: { type: "object" } }
      },
      required: ["profileName", "action"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_file_inject",
    description: "Inject local files into one page file input using page-created File objects and DataTransfer; never opens an OS chooser.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        inputSelector: { type: "string" },
        filePaths: { type: "array", items: { type: "string" }, minItems: 1 }
      },
      required: ["profileName", "tabId", "inputSelector", "filePaths"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_page_asset",
    description: "Save an HTTP(S) media asset exposed by the current page using the exact profile tab's user agent, referer, and matching cookies. Prefer sourceSelector so signed media URLs are resolved inside the plugin and never enter tool arguments or results.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        sourceUrl: { type: "string", description: "Legacy explicit page-exposed media URL. Do not use for signed URLs that must stay out of conversation logs." },
        sourceSelector: { type: "string", description: "Preferred page selector. The plugin resolves the selected element property internally." },
        sourceIndex: { type: "integer", minimum: 0, default: 0 },
        sourceProperty: { enum: ["currentSrc", "src", "href", "poster", "content"], default: "currentSrc" },
        savePath: { type: "string", description: "Absolute local output path. Parent directories are created automatically." },
        expectedMimePrefix: { type: "string", description: "Optional MIME prefix such as video/ or image/." },
        overwrite: { type: "boolean", default: false },
        maxBytes: { type: "integer", minimum: 1, default: 2147483648 }
      },
      required: ["profileName", "tabId", "savePath"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_page_asset_v2",
    description: "Save an HTTP(S) media asset resolved inside the exact profile tab. This cache-safe v2 entry point requires a page selector so signed URLs never enter tool arguments, results, or conversation logs.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        sourceSelector: { type: "string", minLength: 1, description: "Page selector resolved inside the plugin." },
        sourceIndex: { type: "integer", minimum: 0, default: 0 },
        sourceProperty: { enum: ["currentSrc", "src", "href", "poster", "content"], default: "currentSrc" },
        savePath: { type: "string", description: "Absolute local output path. Parent directories are created automatically." },
        expectedMimePrefix: { type: "string", description: "Optional MIME prefix such as video/ or image/." },
        overwrite: { type: "boolean", default: false },
        maxBytes: { type: "integer", minimum: 1, default: 2147483648 }
      },
      required: ["profileName", "tabId", "sourceSelector", "savePath"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_network_asset_v1",
    description: "Save an image or media asset selected from a buffered Network JSON response without exposing its signed URL. The plugin matches one response item, ranks private asset candidates, and downloads the first candidate with the expected MIME type.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        requestId: { type: "string" },
        itemsPath: { type: "string" },
        matchField: { type: "string" },
        matchValue: { type: ["string", "number"] },
        savePath: { type: "string" },
        expectedMimePrefix: { type: "string", default: "image/" },
        overwrite: { type: "boolean", default: false },
        maxBytes: { type: "integer", minimum: 1, default: 2147483648 },
        maxCandidates: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        allowedHostSuffixes: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
          description: "Explicit host suffix allowlist for private asset candidates."
        },
        excludeTerms: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "Optional case-insensitive path or URL substrings to exclude."
        },
        target: { type: "object" }
      },
      required: ["profileName", "tabId", "requestId", "itemsPath", "matchField", "matchValue", "savePath", "allowedHostSuffixes"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_cua",
    description: "Send coordinate mouse, keyboard, typing, or scroll input to one exact tab. For scroll, options accepts x, y, deltaX, and deltaY (legacy scrollX/scrollY aliases are also accepted).",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        action: { enum: ["click", "double_click", "downloadMedia", "drag", "keypress", "move", "scroll", "type"] },
        options: { type: "object" }
      },
      required: ["profileName", "tabId", "action", "options"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_playwright_v2",
    description: "Codex 26.721-compatible page and locator operations in one exact Chrome profile. Locator steps use {type:'css',selector:'...'}, {type:'text',value:'...'}, {type:'role',role:'button',name:'...'}, {type:'label'|'placeholder'|'testId',value:'...'}, or {type:'frame',selector:'...'}. Each step may include filter:{visible,hasText,hasNotText} and nth. Scope duplicate controls with a stable ancestor selector before using fill; count includes obscured background controls, matching Playwright semantics.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        action: {
          enum: [
            "domSnapshot", "elementInfo", "elementScreenshot", "evaluate", "expectNavigation",
            "waitForLoadState", "waitForTimeout", "waitForURL",
            "allTextContents", "count", "isVisible", "isEnabled", "innerText", "textContent",
            "getAttribute", "click", "dblclick", "fill", "type", "press", "check", "uncheck",
            "setChecked", "selectOption", "waitFor", "downloadMedia"
          ]
        },
        locator: {
          type: "object",
          description: "Recursive locator spec. Most calls use {steps:[{type:'css',selector:'ytcp-uploads-dialog #details #title-textarea #textbox[contenteditable=true]',filter:{visible:true}}]}. Composition also accepts {and:[left,right]} or {or:[left,right]}.",
          properties: {
            steps: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  type: { enum: ["css", "text", "role", "label", "placeholder", "testId", "frame"] },
                  selector: { type: "string", description: "Required for css and frame steps." },
                  value: { description: "String or {source,flags} matcher for text, label, placeholder, and testId." },
                  role: { type: "string", description: "Required for role steps." },
                  name: { description: "Optional string or {source,flags} accessible-name matcher for role steps." },
                  options: { type: "object" },
                  filter: {
                    type: "object",
                    properties: {
                      visible: { type: "boolean" },
                      hasText: {},
                      hasNotText: {},
                      has: { type: "object" },
                      hasNot: { type: "object" }
                    },
                    additionalProperties: false
                  },
                  nth: { type: "integer" }
                },
                required: ["type"],
                additionalProperties: false
              }
            },
            and: { type: "array", minItems: 2, maxItems: 2, items: { type: "object" } },
            or: { type: "array", minItems: 2, maxItems: 2, items: { type: "object" } }
          },
          additionalProperties: false
        },
    value: {
      description: "For evaluate, a JavaScript function string such as () => document.title or a direct expression string such as document.title. For locator actions, the action value."
    },
    arg: {
      description: "Optional argument passed to the JavaScript function used by evaluate. Compatibility: when evaluate has no value and arg is a string, arg is treated as the function or direct expression."
    },
        options: { type: "object" },
        savePath: { type: "string" },
        trigger: { type: "object", description: "Locator action used by expectNavigation." }
      },
      required: ["profileName", "tabId", "action"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_dom_cua_v2",
    description: "Codex-compatible DOM CUA operations by node_id from get_visible_dom in one exact profile.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        action: { enum: ["get_visible_dom", "click", "double_click", "downloadMedia", "keypress", "scroll", "type"] },
        options: { type: "object" }
      },
      required: ["profileName", "tabId", "action"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_content_v2",
    description: "Codex-compatible temporary multi-URL extraction or current-tab content export in one exact profile.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        action: { enum: ["tabsContent", "export", "exportGsuite"] },
        urls: { type: "array", items: { type: "string" } },
        contentType: { enum: ["html", "text", "domSnapshot"] },
        type: { enum: ["pdf", "md", "xlsx", "csv", "docx", "pptx"] },
        timeoutMs: { type: "number", minimum: 1, maximum: 120000 }
      },
      required: ["profileName", "action"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_page_event_v2",
    description: "Wait for and act on Codex-compatible download, file chooser, or JavaScript dialog resources in one exact tab.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        action: { enum: ["wait", "downloadPath", "fileChooserSetFiles", "getJsDialog", "dialogAct"] },
        event: { enum: ["download", "filechooser"] },
        resourceId: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        dialogAction: { enum: ["accept", "dismiss"] },
        text: { type: "string" },
        timeoutMs: { type: "number", minimum: 1, maximum: 120000 },
        afterSequence: { type: "number", minimum: 0 }
      },
      required: ["profileName", "tabId", "action"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_session_v2",
    description: "Codex-compatible browser session naming, tab disposition, and finalization for one exact profile.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        action: { enum: ["name", "markHandoff", "markDeliverable", "finalize"] },
        name: { type: "string" },
        tabId: { type: ["string", "number"] },
        keep: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tabId: { type: ["string", "number"] },
              status: { enum: ["handoff", "deliverable"] }
            },
            required: ["tabId", "status"],
            additionalProperties: false
          }
        }
      },
      required: ["profileName", "action"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_cua_scroll_capture_v1",
    description: "Run a gap-free native mouse-wheel capture loop inside one exact profile tab. The plugin serially performs one CDP wheel event, waits for rendering, evaluates the capture expression, and only then starts the next round.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        x: { type: "number" },
        y: { type: "number" },
        deltaX: { type: "number", default: 0 },
        deltaY: { type: "number" },
        settleMs: { type: "integer", minimum: 0, maximum: 10000, default: 800 },
        maxRounds: { type: "integer", minimum: 1, maximum: 500, default: 1 },
        initializeExpression: { type: "string", description: "Optional Runtime.evaluate expression run once before the first wheel event." },
        captureExpression: { type: "string", minLength: 1, description: "Runtime.evaluate expression run after every settled wheel event. It must return a JSON-serializable value." },
        stopField: { type: "string", default: "done", description: "Stop when the returned capture value has this field set to true." }
      },
      required: ["profileName", "tabId", "x", "y", "deltaY", "captureExpression"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_cua_scroll_capture_v2",
    description: "Run a gap-free native mouse-wheel capture loop with plugin-owned completion checks. The plugin serially performs wheel, render wait, and capture, and can stop only after an exact total plus consecutive bottom/no-new rounds.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        x: { type: "number" },
        y: { type: "number" },
        deltaX: { type: "number", default: 0 },
        deltaY: { type: "number" },
        settleMs: { type: "integer", minimum: 0, maximum: 10000, default: 800 },
        maxRounds: { type: "integer", minimum: 1, maximum: 500, default: 1 },
        initializeExpression: { type: "string" },
        captureExpression: { type: "string", minLength: 1 },
        expectedTotal: { type: "integer", minimum: 1, maximum: 1000000 },
        consecutiveNoNewAtBottom: { type: "integer", minimum: 1, maximum: 100, default: 3 },
        stopField: { type: "string", default: "done" }
      },
      required: ["profileName", "tabId", "x", "y", "deltaY", "captureExpression", "expectedTotal", "consecutiveNoNewAtBottom"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_cua_scroll_capture_v3",
    description: "Start a background scroll capture that returns immediately with a jobId. Poll chrome_cua_scroll_capture_status_v1 for progress and final result. Use this for long captures (100+ rounds) that would exceed MCP client timeouts.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        x: { type: "number" },
        y: { type: "number" },
        deltaX: { type: "number", default: 0 },
        deltaY: { type: "number" },
        settleMs: { type: "integer", minimum: 0, maximum: 10000, default: 800 },
        maxRounds: { type: "integer", minimum: 1, maximum: 500, default: 200 },
        initializeExpression: { type: "string" },
        captureExpression: { type: "string", minLength: 1 },
        expectedTotal: { type: "integer", minimum: 1, maximum: 1000000 },
        consecutiveNoNewAtBottom: { type: "integer", minimum: 1, maximum: 100, default: 3 },
        stopField: { type: "string", default: "done" }
      },
      required: ["profileName", "tabId", "x", "y", "deltaY", "captureExpression", "expectedTotal", "consecutiveNoNewAtBottom"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_cua_scroll_capture_status_v1",
    description: "Check progress or get the final result of a background scroll capture job started by chrome_cua_scroll_capture_v3.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_cua_scroll_asset_capture_start_v1",
    description: "Start a background exact-profile virtual-list capture. Each serial wheel checkpoint returns an assets array whose items must be {key, sourceUrl, decoded, width, height}; key is the durable filename stem, sourceUrl stays private, decoded must be true, and width/height must be positive. The plugin immediately downloads them with tab cookies/referer, strips signed URLs, and writes a per-file SHA256 manifest.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        x: { type: "number" },
        y: { type: "number" },
        deltaX: { type: "number", default: 0 },
        deltaY: { type: "number" },
        settleMs: { type: "integer", minimum: 0, maximum: 10000, default: 800 },
        maxRounds: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        initializeExpression: { type: "string" },
        captureExpression: { type: "string", minLength: 1 },
        expectedTotal: { type: "integer", minimum: 1, maximum: 1000000 },
        consecutiveNoNewAtBottom: { type: "integer", minimum: 1, maximum: 100, default: 3 },
        assetField: { type: "string", default: "assets" },
        assetDirectory: { type: "string" },
        manifestPath: { type: "string" },
        maxAssetBytes: { type: "integer", minimum: 1, default: 20971520 },
        downloadConcurrency: { type: "integer", minimum: 1, maximum: 16, default: 4 }
      },
      required: ["profileName", "tabId", "x", "y", "deltaY", "captureExpression", "expectedTotal", "consecutiveNoNewAtBottom", "assetDirectory", "manifestPath"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_cua_scroll_asset_capture_status_v1",
    description: "Read sanitized progress or the final manifest summary for one background virtual-list asset capture job.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_cua_scroll_asset_capture_start_v2",
    description: "Start or resume a durable detached virtual-list asset capture. initializeExpression/captureExpression return an assets array whose items must be {key, sourceUrl, decoded, width, height}; when fallbackToRenderedClip is enabled, an item may also provide renderedClip {x,y,width,height} in document CSS coordinates. key is the durable filename stem, sourceUrl stays private, decoded must be true, and width/height must be positive. The call returns immediately with diagnostics while the connector retains the job promise; progress and terminal failures are atomically persisted, existing thumbnail files can be recovered with fresh hashes, and signed URLs remain internal.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        x: { type: "number" },
        y: { type: "number" },
        deltaX: { type: "number", default: 0 },
        deltaY: { type: "number" },
        settleMs: { type: "integer", minimum: 0, maximum: 10000, default: 800 },
        maxRounds: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        initializeExpression: { type: "string" },
        captureExpression: { type: "string", minLength: 1 },
        expectedTotal: { type: "integer", minimum: 1, maximum: 1000000 },
        consecutiveNoNewAtBottom: { type: "integer", minimum: 1, maximum: 100, default: 3 },
        softBottomBounce: { type: "boolean", default: true },
        rewindBeforeInitialize: { type: "boolean", default: true },
        rewindRounds: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        rewindDeltaY: { type: "number", exclusiveMinimum: 0, default: 3000 },
        rewindSettleMs: { type: "integer", minimum: 0, maximum: 1000, default: 100 },
        assetField: { type: "string", default: "assets" },
        assetDirectory: { type: "string" },
        manifestPath: { type: "string" },
        maxAssetBytes: { type: "integer", minimum: 1, default: 20971520 },
        assetTimeoutMs: { type: "integer", minimum: 1, maximum: 600000, default: 30000 },
        downloadConcurrency: { type: "integer", minimum: 1, maximum: 16, default: 4 },
        stopOnAssetFailure: { type: "boolean", default: false },
        requireTotalAssetParity: { type: "boolean", default: false },
        fallbackToRenderedClip: { type: "boolean", default: false },
        resumeExisting: { type: "boolean", default: false }
      },
      required: [
        "profileName",
        "tabId",
        "x",
        "y",
        "deltaY",
        "initializeExpression",
        "captureExpression",
        "expectedTotal",
        "consecutiveNoNewAtBottom",
        "softBottomBounce",
        "assetDirectory",
        "manifestPath",
        "resumeExisting"
      ],
      additionalProperties: true
    }
  },
  {
    name: "chrome_cua_scroll_asset_capture_status_v2",
    description: "Read durable asset-capture status by manifestPath. Returns a compact summary by default; request asset details explicitly when needed. Works after an MCP process restart because progress is persisted on disk.",
    inputSchema: {
      type: "object",
      properties: {
        manifestPath: { type: "string" },
        includeAssets: { type: "boolean", default: false }
      },
      required: ["manifestPath"],
      additionalProperties: true
    }
  },
  {
    name: "chrome_cua_scroll_asset_capture_cancel_v2",
    description: "Cancel one running durable asset capture by jobId. Cancellation is fail-closed and persists a terminal failed manifest; it never treats partial evidence as complete.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_screenshot",
    description: "Capture a PNG screenshot from a tab in one exact Chrome profile and optionally save it directly to an absolute local path.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        fullPage: { type: "boolean" },
        clip: {
          type: "object",
          properties: {
            x: { type: "number", minimum: 0 },
            y: { type: "number", minimum: 0 },
            width: { type: "number", exclusiveMinimum: 0 },
            height: { type: "number", exclusiveMinimum: 0 }
          },
          required: ["x", "y", "width", "height"],
          additionalProperties: false
        },
        savePath: {
          type: "string",
          description: "Optional absolute local .png path. Parent directories are created automatically."
        }
      },
      required: ["profileName", "tabId"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_verification_detect",
    description: "Detect and classify human-verification challenges (reCAPTCHA, hCaptcha, Cloudflare Turnstile, GeeTest, slider, image-select, text signals) in one exact profile tab. Optionally records a per-profile verification hold so the agent pauses instead of retrying blindly.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        autoHold: { type: "boolean", default: true, description: "Record a verification hold when a challenge is detected." }
      },
      required: ["profileName", "tabId"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_verification_status",
    description: "Return the current verification hold state for one exact profile (idle / challenge_detected / waiting_for_human / cleared) plus recent transitions.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "Number of recent hold transitions to return." }
      },
      required: ["profileName"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_verification_resume",
    description: "Clear the verification hold for one exact profile after the challenge was solved (automatically or by a human in the visible browser).",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        reason: { type: "string", description: "Optional reason recorded in the transition log." }
      },
      required: ["profileName"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_verification_solve",
    description: "Detect a challenge and run the matching solve strategy: checkbox click + token wait (reCAPTCHA v2 / hCaptcha / Turnstile), humanized slider drag (GeeTest / slider), or capture for an external OCR/ASR backend (image-select / generic). On success the hold is cleared; otherwise a human handoff message is returned.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        challenge: {
          type: "object",
          description: "Optional pre-classified challenge ({ type, provider, interactive, frameUrl }) to skip detection.",
          properties: {
            type: { type: "string" },
            provider: { type: "string" },
            interactive: { type: "boolean" },
            frameUrl: { type: "string" }
          },
          additionalProperties: false
        },
        savePath: { type: "string", description: "Absolute path for captured challenge images (capture strategies)." },
        verifyCleared: { type: "boolean", default: true },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 }
      },
      required: ["profileName", "tabId"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_verification_solve_checkbox",
    description: "Click the visible challenge checkbox (reCAPTCHA v2 / hCaptcha / Turnstile) with a human-like click and wait until the hidden response token is populated.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 }
      },
      required: ["profileName", "tabId"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_verification_solve_slider",
    description: "Solve a slider challenge by dragging the handle to the track end (or to an explicit gap offset) with a humanized bezier trajectory (monotonic x, jitter, ease-in-out delays). Optionally polls a verification expression.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        selector: { type: "string", description: "Optional CSS selector for the slider handle; heuristic detection when omitted." },
        gap: { type: "number", description: "Optional target gap x offset from the track left (from a gap-detection backend)." },
        verifyExpression: { type: "string", description: "Optional expression returning true when the slider is accepted." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 }
      },
      required: ["profileName", "tabId"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_verification_capture",
    description: "Capture challenge assets (image region file and/or audio URL) for an external OCR/ASR backend, and optionally submit them to the configured backend for an answer. Returns paths, hashes, and the backend text.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        savePath: { type: "string", description: "Absolute path for the captured challenge image (.png)." },
        mode: { type: "string", enum: ["image", "audio", "both"], default: "both" },
        solve: { type: "boolean", default: true, description: "Submit the capture to the configured backend for an answer." }
      },
      required: ["profileName", "tabId"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_verification_dismiss_overlays",
    description: "Dismiss benign overlays (cookie banners, onboarding tooltips, got-it popups) using a conservative text allowlist. Never touches challenge widgets.",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        tabId: { type: ["string", "number"] },
        maxDismissals: { type: "integer", minimum: 0, maximum: 8, default: 3 }
      },
      required: ["profileName", "tabId"],
      additionalProperties: false
    }
  }
];

async function browser(profileName) {
  return agent.browsers.get(`extension:${profileName}`);
}

function matcherFromJson(value) {
  if (value && typeof value === "object" && typeof value.source === "string") {
    return new RegExp(value.source, value.flags || "");
  }
  return value;
}

function locatorFromSpec(tab, spec) {
  if (!spec || typeof spec !== "object") throw new TypeError("A locator spec is required for this action");
  if (Array.isArray(spec.and) && spec.and.length === 2) {
    return locatorFromSpec(tab, spec.and[0]).and(locatorFromSpec(tab, spec.and[1]));
  }
  if (Array.isArray(spec.or) && spec.or.length === 2) {
    return locatorFromSpec(tab, spec.or[0]).or(locatorFromSpec(tab, spec.or[1]));
  }
  const steps = Array.isArray(spec.steps) ? spec.steps : [];
  if (!steps.length) throw new TypeError("Locator spec requires at least one step");
  let scope = tab.playwright;
  let locator;
  for (const step of steps) {
    if (step.type === "frame") {
      if (locator) throw new Error("A frame step must precede element locator steps");
      scope = scope.frameLocator(step.selector);
      continue;
    }
    if (step.type === "css") locator = scope.locator(step.selector, step.options || {});
    else if (step.type === "text") locator = scope.getByText(matcherFromJson(step.value), step.options || {});
    else if (step.type === "role") locator = scope.getByRole(step.role, { ...(step.options || {}), ...(step.name == null ? {} : { name: matcherFromJson(step.name) }) });
    else if (step.type === "label") locator = scope.getByLabel(matcherFromJson(step.value), step.options || {});
    else if (step.type === "placeholder") locator = scope.getByPlaceholder(matcherFromJson(step.value), step.options || {});
    else if (step.type === "testId") locator = scope.getByTestId(step.value);
    else throw new Error(`Unsupported locator step: ${step.type}`);
    scope = locator;
    if (step.filter) {
      locator = locator.filter({
        ...step.filter,
        hasText: matcherFromJson(step.filter.hasText),
        hasNotText: matcherFromJson(step.filter.hasNotText),
        has: step.filter.has ? locatorFromSpec(tab, step.filter.has) : undefined,
        hasNot: step.filter.hasNot ? locatorFromSpec(tab, step.filter.hasNot) : undefined
      });
      scope = locator;
    }
    if (Number.isInteger(step.nth)) {
      locator = locator.nth(step.nth);
      scope = locator;
    }
  }
  return locator;
}

async function invokeLocator(locator, action, value, options = {}) {
  const method = locator?.[action];
  if (typeof method !== "function") throw new Error(`Unsupported locator action: ${action}`);
  if (["fill", "type", "press", "selectOption", "setChecked"].includes(action)) return method.call(locator, value, options);
  if (action === "getAttribute") return method.call(locator, String(value), options);
  if (action === "waitFor") return method.call(locator, options);
  return method.call(locator, options);
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: schemas }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const args = params.arguments || {};
  try {
    if (params.name === "chrome_profiles") return textResult(await agent.browsers.list());
    if (params.name === "chrome_profile_catalog") {
      const catalog = await readChromeProfileCatalog(config);
      return textResult(publicChromeProfileCatalog(catalog));
    }
    if (params.name === "chrome_profile_start") {
      return textResult(await launchChromeProfile({
        router,
        config,
        profileName: args.profileName,
        timeoutMs: args.timeoutMs
      }));
    }
    if (params.name === "chrome_selftest") {
      return textResult(await runProfileSelftest({
        router,
        getBrowser: browser,
        profileName: args.profileName,
        tabId: args.tabId,
        implementationVersion: IMPLEMENTATION_VERSION
      }));
    }
    if (params.name === "chrome_tabs") {
      const selected = await browser(args.profileName);
      if (args.action === "list") return textResult(await selected.tabs.list());
      if (args.action === "new") {
        const tab = await createTabWithNavigation(selected, args.url);
        return textResult({ id: tab.id, url: await tab.url(), title: await tab.title() });
      }
      const tab = await selected.tabs.get(args.tabId);
      if (args.action === "get") return textResult({ id: tab.id, url: await tab.url(), title: await tab.title() });
      if (args.action === "activate") await tab.activate();
      if (args.action === "navigate") await tab.goto(args.url);
      if (args.action === "reload") await tab.reload();
      if (args.action === "back") await tab.back();
      if (args.action === "forward") await tab.forward();
      if (args.action === "close") await tab.close();
      return textResult({ ok: true });
    }
    if (params.name === "chrome_cdp") {
      if (args.action === "readEvents") {
        return textResult(await router.request(args.profileName, "cdp.readEvents", {
          tabId: args.tabId,
          options: args.options || {}
        }));
      }
      if (args.action === "readResponseJson") {
        const requestId = args.params?.requestId;
        if (!requestId) throw new Error("requestId is required for readResponseJson");
        const response = await readNetworkResponseBody(
          args.profileName,
          args.tabId,
          requestId,
          args.target
        );
        return textResult(summarizeNetworkJsonBody(response, args.params || {}));
      }
      if (args.action === "readResponseJsonBatch") {
        const requestIds = [...new Set(args.params?.requestIds || [])];
        if (!requestIds.length) throw new Error("requestIds is required for readResponseJsonBatch");
        if (requestIds.length > 200) throw new Error("readResponseJsonBatch accepts at most 200 requestIds");
        const entries = [];
        for (const requestId of requestIds) {
          try {
            const response = await readNetworkResponseBody(
              args.profileName,
              args.tabId,
              requestId,
              args.target
            );
            entries.push({
              requestId,
              summary: summarizeNetworkJsonBody(response, args.params || {})
            });
          } catch (error) {
            entries.push({ requestId, error: error?.message || String(error) });
          }
        }
        return textResult(groupNetworkJsonSummaries(entries));
      }
      if (args.action === "readResponseJsonEvents") {
        const eventPage = await router.request(args.profileName, "cdp.readEvents", {
          tabId: args.tabId,
          options: {
            ...(args.options || {}),
            methods: ["Network.responseReceived"],
            includeSensitive: false
          }
        });
        const requestIds = [...new Set(
          eventPage.events
            .map((event) => event.params?.requestId)
            .filter(Boolean)
        )];
        const entries = [];
        for (const requestId of requestIds) {
          try {
            const response = await readNetworkResponseBody(
              args.profileName,
              args.tabId,
              requestId,
              args.target
            );
            entries.push({
              requestId,
              summary: summarizeNetworkJsonBody(response, args.params || {})
            });
          } catch (error) {
            entries.push({ requestId, error: error?.message || String(error) });
          }
        }
        return textResult({
          cursor: eventPage.cursor,
          hasMore: eventPage.hasMore,
          truncated: eventPage.truncated,
          ...compactNetworkJsonGroups(groupNetworkJsonSummaries(entries))
        });
      }
      if (args.action === "readRequestData") {
        const requestId = args.params?.requestId;
        if (!requestId) throw new Error("requestId is required for readRequestData");
        const response = await router.request(args.profileName, "cdp.send", {
          tabId: args.tabId,
          cdpMethod: "Network.getRequestPostData",
          cdpParams: { requestId },
          cdpOptions: { target: args.target }
        });
        return textResult(summarizeNetworkRequestPostData(response, args.params || {}));
      }
      if (!args.method) throw new Error("method is required for chrome_cdp send");
      return textResult(await router.request(args.profileName, "cdp.send", {
        tabId: args.tabId,
        cdpMethod: args.method,
        cdpParams: args.params || {},
        cdpOptions: { target: args.target }
      }));
    }
    if (params.name === "chrome_locator") {
      const tab = await (await browser(args.profileName)).tabs.get(args.tabId);
      let locator = tab.playwright.locator(args.selector);
      if (args.index != null) locator = locator.nth(args.index);
      const action = locator[args.action];
      if (typeof action !== "function") throw new Error(`Unsupported locator action: ${args.action}`);
      const invoke = async () => {
        if (["fill", "type", "press", "selectOption"].includes(args.action)) return action.call(locator, args.value, args.options || {});
        if (args.action === "getAttribute") return action.call(locator, String(args.value), args.options || {});
        if (args.action === "waitFor") return action.call(locator, args.options || args.value || {});
        return action.call(locator, args.options || {});
      };
      const mutating = new Set(["click", "fill", "type", "press", "check", "uncheck", "selectOption"]);
      const result = mutating.has(args.action)
        ? await tabMutationQueue.run(args.profileName, args.tabId, invoke)
        : await invoke();
      return textResult(result ?? { ok: true });
    }
    if (params.name === "chrome_playwright_v2") {
      const tab = await (await browser(args.profileName)).tabs.get(args.tabId);
      const pageActions = new Set(["domSnapshot", "elementInfo", "elementScreenshot", "evaluate", "expectNavigation", "waitForLoadState", "waitForTimeout", "waitForURL"]);
      if (!pageActions.has(args.action)) {
        const locator = locatorFromSpec(tab, args.locator);
        const mutating = new Set(["click", "dblclick", "fill", "type", "press", "check", "uncheck", "setChecked", "selectOption", "downloadMedia"]);
        const invoke = () => invokeLocator(locator, args.action, args.value, args.options || {});
        const result = mutating.has(args.action)
          ? await tabMutationQueue.run(args.profileName, args.tabId, invoke)
          : await invoke();
        return textResult(result ?? { ok: true });
      }
      if (args.action === "domSnapshot") return textResult(await tab.playwright.domSnapshot());
      if (args.action === "elementInfo") return textResult(await tab.playwright.elementInfo(args.options || {}));
      if (args.action === "elementScreenshot") {
        const bytes = await tab.playwright.elementScreenshot(args.options || {});
        if (!args.savePath) return textResult({ pngBase64: Buffer.from(bytes).toString("base64") });
        if (!isAbsolute(args.savePath)) throw new Error("savePath must be absolute");
        await mkdir(dirname(args.savePath), { recursive: true });
        await writeFile(args.savePath, bytes);
        return textResult({ savedPath: args.savePath, bytes: bytes.length });
      }
      if (args.action === "evaluate") {
        const expression = args.value ?? (typeof args.arg === "string" ? args.arg : undefined);
        const evaluationArg = args.value == null && typeof args.arg === "string" ? undefined : args.arg;
        return textResult(await tab.playwright.evaluate(expression, evaluationArg, args.options || {}));
      }
      if (args.action === "expectNavigation") {
        const trigger = args.trigger || {};
        const locator = locatorFromSpec(tab, trigger.locator);
        const action = async () => invokeLocator(locator, trigger.action || "click", trigger.value, trigger.options || {});
        return textResult(await tabMutationQueue.run(args.profileName, args.tabId, () =>
          tab.playwright.expectNavigation(action, args.options || {})
        ) ?? { ok: true });
      }
      await tab.playwright[args.action](args.action === "waitForTimeout" ? args.value : (args.value ?? args.options ?? {}), args.options || {});
      return textResult({ ok: true });
    }
    if (params.name === "chrome_dom_cua_v2") {
      const tab = await (await browser(args.profileName)).tabs.get(args.tabId);
      const action = tab.dom_cua[args.action];
      if (typeof action !== "function") throw new Error(`Unsupported DOM CUA action: ${args.action}`);
      const mutating = args.action !== "get_visible_dom";
      const invoke = () => action(args.options || {});
      return textResult((mutating ? await tabMutationQueue.run(args.profileName, args.tabId, invoke) : await invoke()) ?? { ok: true });
    }
    if (params.name === "chrome_content_v2") {
      const selected = await browser(args.profileName);
      if (args.action === "tabsContent") {
        return textResult(await selected.tabs.content({
          urls: args.urls || [],
          contentType: args.contentType,
          timeoutMs: args.timeoutMs
        }));
      }
      const tab = await selected.tabs.get(args.tabId);
      return textResult({
        path: args.action === "export"
          ? await tab.content.export()
          : await tab.content.exportGsuite(args.type)
      });
    }
    if (params.name === "chrome_page_event_v2") {
      const tab = await (await browser(args.profileName)).tabs.get(args.tabId);
      if (args.action === "wait") {
        if (!args.event) throw new Error("event is required for wait");
        return textResult(await tab.transport.session(tab.id, "waitForEvent", {
          name: args.event,
          afterSequence: args.afterSequence || 0,
          timeoutMs: args.timeoutMs || 30000
        }));
      }
      if (args.action === "getJsDialog") return textResult(await tab.transport.session(tab.id, "currentDialog", {}));
      if (args.action === "downloadPath") return textResult(await tab.transport.session(tab.id, "downloadPath", {
        resourceId: args.resourceId,
        timeoutMs: args.timeoutMs || 30000
      }));
      if (args.action === "fileChooserSetFiles") return textResult(await tab.transport.session(tab.id, "fileChooserSetFiles", {
        resourceId: args.resourceId,
        files: args.files || [],
        timeoutMs: args.timeoutMs || 30000
      }));
      return textResult(await tab.transport.session(tab.id, "dialogAct", {
        resourceId: args.resourceId,
        action: args.dialogAction,
        text: args.text
      }));
    }
    if (params.name === "chrome_session_v2") {
      const selected = await browser(args.profileName);
      if (args.action === "name") {
        await selected.nameSession(args.name);
        return textResult({ ok: true });
      }
      if (args.action === "markHandoff" || args.action === "markDeliverable") {
        const tab = await selected.tabs.get(args.tabId);
        await tab[args.action]();
        return textResult({ ok: true });
      }
      const result = await selected.tabs.finalize({
        keep: (args.keep || []).map((entry) => ({ tab: String(entry.tabId), status: entry.status }))
      });
      return textResult({ ok: true, ...result });
    }
    if (params.name === "chrome_history") {
      const selected = await browser(args.profileName);
      return textResult(await selected.user.history(args));
    }
    if (params.name === "chrome_clipboard") {
      if (args.action === "readItems" || args.action === "writeItems") {
        if (args.tabId == null) throw new Error("tabId is required for binary clipboard actions");
        const tab = await (await browser(args.profileName)).tabs.get(args.tabId);
        return textResult(args.action === "readItems"
          ? await tab.clipboard.read()
          : await tab.clipboard.write(args.items || []) ?? { ok: true });
      }
      const method = args.action === "read" ? "clipboard.readText" : "clipboard.writeText";
      return textResult(await router.request(args.profileName, method, { text: args.text || "" }));
    }
    if (params.name === "chrome_file_inject") {
      const tab = await (await browser(args.profileName)).tabs.get(args.tabId);
      return textResult(await injectFilesViaPageFile(tab, args.filePaths, args.inputSelector));
    }
    if (params.name === "chrome_page_asset" || params.name === "chrome_page_asset_v2") {
      await (await browser(args.profileName)).tabs.get(args.tabId);
      return textResult(await savePageAsset({
        router,
        profileName: args.profileName,
        tabId: args.tabId,
        sourceUrl: args.sourceUrl,
        sourceSelector: args.sourceSelector,
        sourceIndex: args.sourceIndex,
        sourceProperty: args.sourceProperty,
        savePath: args.savePath,
        expectedMimePrefix: args.expectedMimePrefix,
        overwrite: !!args.overwrite,
        maxBytes: args.maxBytes
      }));
    }
    if (params.name === "chrome_network_asset_v1") {
      await (await browser(args.profileName)).tabs.get(args.tabId);
      const response = await readNetworkResponseBody(
        args.profileName,
        args.tabId,
        args.requestId,
        args.target
      );
      const selection = selectNetworkJsonAssetCandidates(response, {
        itemsPath: args.itemsPath,
        matchField: args.matchField,
        matchValue: args.matchValue,
        maxCandidates: args.maxCandidates,
        allowedHostSuffixes: args.allowedHostSuffixes,
        excludeTerms: args.excludeTerms
      });
      if (!selection.matched) throw new Error("No matching response item found");
      if (!selection.candidates.length) throw new Error("Matching response item had no eligible asset candidates");
      const failures = [];
      for (let index = 0; index < selection.candidates.length; index += 1) {
        try {
          const saved = await savePageAsset({
            router,
            profileName: args.profileName,
            tabId: args.tabId,
            sourceUrl: selection.candidates[index],
            savePath: args.savePath,
            expectedMimePrefix: args.expectedMimePrefix || "image/",
            overwrite: !!args.overwrite,
            maxBytes: args.maxBytes,
            privateSource: true
          });
          return textResult({
            ok: true,
            matched: true,
            candidateCount: selection.candidateCount,
            selectedCandidateIndex: index,
            savedPath: saved.savedPath,
            bytes: saved.bytes,
            sha256: saved.sha256,
            contentType: saved.contentType,
            profileName: saved.profileName,
            tabId: saved.tabId,
            profileContext: saved.profileContext,
            sourceResolvedInsidePlugin: true,
            signedUrlsExposed: false
          });
        } catch (error) {
          failures.push({ candidateIndex: index, error: error?.message || String(error) });
        }
      }
      throw new Error(`No response asset candidate could be saved (${failures.map((entry) => `${entry.candidateIndex}:${entry.error}`).join("; ")})`);
    }
    if (params.name === "chrome_cua") {
      const tab = await (await browser(args.profileName)).tabs.get(args.tabId);
      const action = tab.cua[args.action];
      if (typeof action !== "function") throw new Error(`Unsupported CUA action: ${args.action}`);
      return textResult(await action(args.options) ?? { ok: true });
    }
    if (params.name === "chrome_cua_scroll_capture_v1" || params.name === "chrome_cua_scroll_capture_v2") {
      const tab = await (await browser(args.profileName)).tabs.get(args.tabId);
      return textResult(await tabMutationQueue.run(args.profileName, args.tabId, () => runCuaScrollCapture({
        tab,
        x: args.x,
        y: args.y,
        deltaX: args.deltaX,
        deltaY: args.deltaY,
        settleMs: args.settleMs,
        maxRounds: args.maxRounds,
        initializeExpression: args.initializeExpression,
        captureExpression: args.captureExpression,
        stopField: args.stopField,
        expectedTotal: args.expectedTotal,
        consecutiveNoNewAtBottom: args.consecutiveNoNewAtBottom
      })));
    }
    if (params.name === "chrome_cua_scroll_capture_v3") {
      const jobId = randomUUID();
      const job = { jobId, state: "running", startedAt: new Date().toISOString(), roundsCompleted: 0, lastValue: null, result: null, error: null };
      scrollCaptureJobs.set(jobId, job);
      const tab = await (await browser(args.profileName)).tabs.get(args.tabId);
      tabMutationQueue.run(args.profileName, args.tabId, () => runCuaScrollCapture({
        tab,
        x: args.x,
        y: args.y,
        deltaX: args.deltaX,
        deltaY: args.deltaY,
        settleMs: args.settleMs,
        maxRounds: args.maxRounds,
        initializeExpression: args.initializeExpression,
        captureExpression: args.captureExpression,
        stopField: args.stopField,
        expectedTotal: args.expectedTotal,
        consecutiveNoNewAtBottom: args.consecutiveNoNewAtBottom,
        onCheckpoint: (value, round) => { job.roundsCompleted = round; job.lastValue = value; }
      })).then((result) => { job.state = "done"; job.result = result; }).catch((err) => { job.state = "error"; job.error = err?.message || String(err); });
      return textResult({ ok: true, jobId, state: "running" });
    }
    if (params.name === "chrome_cua_scroll_capture_status_v1") {
      const job = scrollCaptureJobs.get(args.jobId);
      if (!job) throw new Error("Unknown scroll capture jobId");
      return textResult(job);
    }
    if (params.name === "chrome_cua_scroll_asset_capture_start_v1" || params.name === "chrome_cua_scroll_asset_capture_start_v2") {
      const isV2 = params.name === "chrome_cua_scroll_asset_capture_start_v2";
      const effectiveMaxRounds = args.maxRounds ?? (isV2 ? 100 : 1);
      const executionMode = isV2 ? "background-durable" : "background";
      const tab = await (await browser(args.profileName)).tabs.get(args.tabId);
      const jobId = randomUUID();
      const job = {
        jobId,
        state: "running",
        profileName: args.profileName,
        tabId: String(args.tabId),
        startedAt: new Date().toISOString(),
        progress: null,
        manifestPath: args.manifestPath,
        diagnostics: {
          implementationVersion: IMPLEMENTATION_VERSION,
          executionMode,
          effectiveMaxRounds
        },
        abortController: isV2 ? new AbortController() : null
      };
      assetCaptureJobs.set(jobId, job);
      const capturePromise = tabMutationQueue.run(args.profileName, args.tabId, () => runScrollAssetCapture({
        router,
        tab,
        profileName: args.profileName,
        tabId: args.tabId,
        x: args.x,
        y: args.y,
        deltaX: args.deltaX,
        deltaY: args.deltaY,
        settleMs: args.settleMs,
        maxRounds: effectiveMaxRounds,
        initializeExpression: args.initializeExpression,
        captureExpression: args.captureExpression,
        expectedTotal: args.expectedTotal,
        consecutiveNoNewAtBottom: args.consecutiveNoNewAtBottom,
        softBottomBounce: params.name === "chrome_cua_scroll_asset_capture_start_v2"
          ? args.softBottomBounce !== false
          : false,
        rewindBeforeInitialize: params.name === "chrome_cua_scroll_asset_capture_start_v2"
          ? !!args.resumeExisting && args.rewindBeforeInitialize !== false
          : false,
        rewindRounds: args.rewindRounds,
        rewindDeltaY: args.rewindDeltaY,
        rewindSettleMs: args.rewindSettleMs,
        assetField: args.assetField,
        assetDirectory: args.assetDirectory,
        manifestPath: args.manifestPath,
        maxAssetBytes: args.maxAssetBytes,
        assetTimeoutMs: args.assetTimeoutMs,
        downloadConcurrency: args.downloadConcurrency,
        stopOnAssetFailure: !!args.stopOnAssetFailure,
        requireTotalAssetParity: !!args.requireTotalAssetParity,
        fallbackToRenderedClip: !!args.fallbackToRenderedClip,
        resumeExisting: !!args.resumeExisting,
        signal: job.abortController?.signal,
        diagnostics: job.diagnostics,
        onProgress: (progress) => { job.progress = progress; }
      }));
      const completeJob = ({ manifest }) => {
        job.state = manifest.ok ? "completed" : "failed";
        job.finishedAt = new Date().toISOString();
        job.result = {
          ok: manifest.ok,
          stopped: manifest.stopped,
          roundsCompleted: manifest.roundsCompleted,
          last: manifest.last,
          assetCount: manifest.assetCount,
          failureCount: manifest.failureCount,
          manifestPath: args.manifestPath,
          diagnostics: job.diagnostics,
          signedUrlsExposed: false
        };
        return manifest;
      };
      const failJob = (error) => {
        job.state = "failed";
        job.finishedAt = new Date().toISOString();
        job.error = error?.message || String(error);
        return null;
      };
      if (isV2) {
        const retainedPromise = capturePromise
          .then(completeJob, failJob)
          .finally(() => activeAssetCapturePromises.delete(jobId));
        activeAssetCapturePromises.set(jobId, retainedPromise);
        return textResult({
          jobId,
          state: job.state,
          manifestPath: args.manifestPath,
          diagnostics: job.diagnostics
        });
      }
      const retainedPromise = capturePromise
        .then(completeJob, failJob)
        .finally(() => activeAssetCapturePromises.delete(jobId));
      activeAssetCapturePromises.set(jobId, retainedPromise);
      return textResult({
        jobId,
        state: job.state,
        manifestPath: args.manifestPath,
        diagnostics: job.diagnostics
      });
    }
    if (params.name === "chrome_cua_scroll_asset_capture_status_v1") {
      const job = assetCaptureJobs.get(args.jobId);
      if (!job) throw new Error("Unknown asset capture jobId");
      return textResult(job);
    }
    if (params.name === "chrome_cua_scroll_asset_capture_status_v2") {
      if (!isAbsolute(args.manifestPath || "")) throw new Error("manifestPath must be an absolute local path");
      const manifest = JSON.parse(await readFile(args.manifestPath, "utf8"));
      return textResult(summarizeAssetCaptureManifest(manifest, { includeAssets: !!args.includeAssets }));
    }
    if (params.name === "chrome_cua_scroll_asset_capture_cancel_v2") {
      const job = assetCaptureJobs.get(args.jobId);
      if (!job) throw new Error("Unknown asset capture jobId");
      if (!job.abortController) throw new Error("The requested job is not a durable v2 asset capture");
      if (["completed", "failed"].includes(job.state)) {
        return textResult({ ok: true, jobId: job.jobId, state: job.state, alreadyTerminal: true });
      }
      job.state = "cancelling";
      job.abortController.abort(new Error("asset_capture_cancelled"));
      return textResult({ ok: true, jobId: job.jobId, state: job.state });
    }
    if (params.name === "chrome_screenshot") {
      const tab = await (await browser(args.profileName)).tabs.get(args.tabId);
      const bytes = await tab.screenshot({ fullPage: !!args.fullPage, clip: args.clip });
      const png = Buffer.from(bytes);
      const content = [];
      if (args.savePath) {
        if (!isAbsolute(args.savePath)) throw new Error("chrome_screenshot savePath must be an absolute local path");
        if (!args.savePath.toLowerCase().endsWith(".png")) throw new Error("chrome_screenshot savePath must end with .png");
        await mkdir(dirname(args.savePath), { recursive: true });
        await writeFile(args.savePath, png);
        content.push({
          type: "text",
          text: JSON.stringify({ ok: true, savedPath: args.savePath, bytes: png.length }, null, 2)
        });
      }
      content.push({ type: "image", mimeType: "image/png", data: png.toString("base64") });
      return { content };
    }
    if (params.name.startsWith("chrome_verification")) {
      const profileName = args.profileName;
      if (params.name === "chrome_verification_status") {
        return textResult({
          ...verification.status(profileName),
          recentTransitions: verification.recentTransitions(args.limit ?? 10)
        });
      }
      if (params.name === "chrome_verification_resume") {
        return textResult(verification.resume(profileName, { reason: args.reason || "manual" }));
      }
      const tab = await (await browser(profileName)).tabs.get(args.tabId);
      const evaluate = (expression) => tab.playwright.evaluate(expression);
      const click = async ({ x, y }) => tab.cua.click({ x, y });
      const drag = async ({ path, delays }) => tab.cua.drag({ path, delays });
      const screenshot = async ({ clip, savePath }) => {
        const bytes = await tab.screenshot({ clip });
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (!savePath) return { savedPath: null, bytes: bytes.length, sha256 };
        if (!isAbsolute(savePath)) throw new Error("chrome_verification capture savePath must be absolute");
        await mkdir(dirname(savePath), { recursive: true });
        await writeFile(savePath, bytes);
        return { savedPath: savePath, bytes: bytes.length, sha256 };
      };
      if (params.name === "chrome_verification_detect") {
        const detection = await detectChallenge({ evaluate, tabId: tab.id });
        if (args.autoHold !== false && detection.detected) {
          verification.report(profileName, detection.challenges[0]);
        }
        return textResult({ profileName, ...detection, hold: verification.status(profileName) });
      }
      if (params.name === "chrome_verification_dismiss_overlays") {
        return textResult({ profileName, ...(await dismissBenignOverlays({ evaluate, click, maxDismissals: args.maxDismissals })) });
      }
      if (params.name === "chrome_verification_solve_checkbox") {
        const result = await solveCheckbox({ evaluate, click, timeoutMs: args.timeoutMs });
        if (result.solved) verification.resume(profileName, { reason: "checkbox solved" });
        else verification.handoff(profileName, { type: "recaptcha-v2" });
        return textResult({ profileName, ...result });
      }
      if (params.name === "chrome_verification_solve_slider") {
        const result = await solveSlider({
          evaluate,
          drag,
          selector: args.selector,
          gap: args.gap,
          verifyExpression: args.verifyExpression ?? solveSliderVerifyDefault,
          timeoutMs: args.timeoutMs
        });
        if (result.solved) verification.resume(profileName, { reason: "slider solved" });
        else verification.handoff(profileName, { type: "slider" });
        return textResult({ profileName, ...result });
      }
      if (params.name === "chrome_verification_capture") {
        const result = await captureChallengeAssets({ evaluate, screenshot, savePath: args.savePath });
        const backendAnswers = [];
        if (result.captured && args.solve !== false && verificationBackend) {
          try {
            if (args.mode !== "audio" && result.image?.path) {
              const backendResult = await verificationBackend.solveImage({ imagePath: result.image.path });
              backendAnswers.push({ kind: "image", text: backendResult?.text ?? backendResult ?? null });
            }
            if (args.mode !== "image" && (result.audioSrc || result.audioLink)) {
              const backendResult = await verificationBackend.solveAudio({ audioUrl: result.audioSrc || result.audioLink });
              backendAnswers.push({ kind: "audio", text: backendResult?.text ?? backendResult ?? null });
            }
          } catch (error) {
            backendAnswers.push({ error: error.message });
          }
        }
        return textResult({ profileName, ...result, backendAnswers: backendAnswers.length ? backendAnswers : null });
      }
      if (params.name === "chrome_verification_solve") {
        const detection = args.challenge
          ? { detected: true, challenges: [args.challenge] }
          : await detectChallenge({ evaluate, tabId: tab.id });
        if (!detection.detected) return textResult({ profileName, detected: false, result: "no_challenge" });
        const challenge = detection.challenges[0];
        verification.report(profileName, challenge);
        let result;
        try {
          result = await runSolvePipeline({
            challenge,
            evaluate,
            click,
            drag,
            screenshot,
            savePath: args.savePath,
            backend: verificationBackend,
            verifyCleared: args.verifyCleared !== false,
            timeoutMs: args.timeoutMs
          });
        } catch (error) {
          // A solver crash must not leave the profile stuck in
          // challenge_detected; roll the hold back and surface the error.
          verification.resume(profileName, { reason: "solver_error" });
          throw error;
        }
        if (result.solved) verification.resume(profileName, { reason: `solved ${challenge.type}` });
        else verification.handoff(profileName, challenge);
        return textResult({
          profileName,
          challenge,
          ...result,
          hold: verification.status(profileName),
          ...(result.solved ? {} : { handoff: buildHandoffMessage({ profileName, challenge }) })
        });
      }
      throw new Error(`Unknown verification tool: ${params.name}`);
    }
    throw new Error(`Unknown tool: ${params.name}`);
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error?.message || String(error) }] };
  }
});

await server.connect(new StdioServerTransport());
process.on("SIGINT", async () => { await router.close(); process.exit(0); });
process.on("SIGTERM", async () => { await router.close(); process.exit(0); });

import { readFile } from "node:fs/promises";
import path from "node:path";

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"
  }[extension] || "application/octet-stream";
}

// This intentionally uses page-created File objects and DataTransfer. It never
// opens an OS chooser and never calls DOM.setFileInputFiles.
export async function injectFilesViaPageFile(tab, filePaths, inputSelector, { chunkSize = 196608 } = {}) {
  const cdp = await tab.capabilities.get("cdp");
  const send = (expression) => cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  const probe = await send(`document.querySelectorAll(${JSON.stringify(inputSelector)}).length`);
  if (probe.result?.value !== 1) throw new Error(`File input must resolve exactly once; found ${probe.result?.value}`);
  await send("window.__agentOsUploadSpecs=[]");
  const evidence = [];
  for (const filePath of filePaths) {
    const bytes = await readFile(filePath);
    await send("window.__agentOsUploadChunks=[]");
    let chunks = 0;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const base64 = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)).toString("base64");
      await send(`(()=>{const s=atob(${JSON.stringify(base64)}),a=new Uint8Array(s.length);for(let i=0;i<s.length;i++)a[i]=s.charCodeAt(i);window.__agentOsUploadChunks.push(a);return true})()`);
      chunks += 1;
    }
    await send(`window.__agentOsUploadSpecs.push({name:${JSON.stringify(path.basename(filePath))},type:${JSON.stringify(mimeType(filePath))},chunks:window.__agentOsUploadChunks});window.__agentOsUploadChunks=[];true`);
    evidence.push({ filePath, bytes: bytes.length, chunks });
  }
  const result = await send(`(()=>{
    const input=document.querySelector(${JSON.stringify(inputSelector)});
    const transfer=new DataTransfer();
    for(const spec of window.__agentOsUploadSpecs){
      transfer.items.add(new File(spec.chunks,spec.name,{type:spec.type}));
    }
    input.files=transfer.files;
    input.dispatchEvent(new Event("input",{bubbles:true}));
    input.dispatchEvent(new Event("change",{bubbles:true}));
    const value={count:input.files.length,names:[...input.files].map(x=>x.name),sizes:[...input.files].map(x=>x.size)};
    delete window.__agentOsUploadSpecs;
    return value;
  })()`);
  if (result.result?.value?.count !== filePaths.length) throw new Error("Page File injection did not retain every file");
  return { ...result.result.value, files: evidence };
}

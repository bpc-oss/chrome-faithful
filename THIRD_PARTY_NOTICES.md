# Third-party notices

The npm lockfile is the authoritative dependency inventory. MCPB builds run
`npm ci --omit=dev --ignore-scripts` inside a clean staging directory, so the
distributed production dependency tree is derived from that lockfile rather
than copied from a developer machine.

## @modelcontextprotocol/sdk 1.x

Copyright Anthropic, PBC.

Licensed under the MIT License.

Source: https://github.com/modelcontextprotocol/typescript-sdk

## ws 8.x

Copyright (c) 2011 Einar Otto Stangvik and contributors.

Licensed under the MIT License.

Source: https://github.com/websockets/ws

## puppeteer-core 25.7.0

Copyright 2017 Google Inc.

Licensed under the Apache License, Version 2.0.

Source: https://github.com/puppeteer/puppeteer

Only Puppeteer's browser build and `ExtensionTransport` are bundled. The plugin
does not use Puppeteer's browser launcher or download a browser.

## esbuild 0.28.1

Copyright Evan Wallace and esbuild contributors.

Licensed under the MIT License.

Source: https://github.com/evanw/esbuild

esbuild is a development-time build tool and is omitted from the production
MCPB dependency install. Its generated output retains applicable legal
comments from bundled sources.

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

## yaml 2.9.0

Copyright Eemeli Aro.

Licensed under the ISC License.

Source: https://github.com/eemeli/yaml

yaml is used only by development-time DSH bundle contract tests and is omitted
from the production MCPB dependency install.

## @deepseek-ai/dsh-app-boot 0.1.0-rc.6

Copyright (c) 2026 DeepSeek.

Licensed under the MIT License.

Source: https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a/packages/boot/app-boot

This pinned package is used only by the hermetic DSH host-contract tests and is
omitted from the production MCPB dependency install.

## Optional PaddleOCR / PP-OCRv5 integration

Copyright PaddlePaddle Authors.

PaddleOCR source code is licensed under the Apache License, Version 2.0.

Source: https://github.com/PaddlePaddle/PaddleOCR

Chrome Faithful includes only its own protocol adapter. PaddleOCR,
PaddlePaddle, OpenCV, NumPy, Python environments, and PP-OCR model artifacts
are not dependencies or redistributed files. Users install and license those
optional components separately.

## @deepseek-ai/dsh-mcp-client 0.1.0-rc.6

Copyright (c) 2026 DeepSeek.

Licensed under the MIT License.

Source: https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a/packages/mcp/mcp-client

This pinned package is used only by the hermetic DSH host-contract tests and is
omitted from the production MCPB dependency install.

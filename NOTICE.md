# Attribution and upstream

This is a local derivative of [JialaoLiu/dsh-baton](https://github.com/JialaoLiu/dsh-baton), MIT licensed, based on commit `27856b463a7344952da32263719acb6ae97f8bef` (version 0.6.11).

The original MIT copyright and license are retained in LICENSE. The stdio hot-reload shell (`src/server.mjs`), independent evidence engine (`src/evidence.mjs`), and evidence regression tests derive directly from Baton. The tools retain its send/status/wait/answer/cancel/call arrangement, session continuation, queue/steer semantics, and evidence-based handoff design. The Harness host plugin is replaced by a local broker and Factory Droid JSON-RPC subprocess adapter.

The Factory protocol field mappings were checked against the official Droid CLI 0.240.0 (wire protocol 1.260.0) and the published `@factory/droid-sdk` 0.10.0 schemas. The SDK is not bundled or required. This project is not an official Factory or OpenAI integration.

The original repository history remains available through the local `upstream` Git remote. No release has been published to npm or GitHub.

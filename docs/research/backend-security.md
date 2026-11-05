# Backend/Platform security research (retrieved 2026-11-05)

Sources: OWASP cheat sheets (File_Upload, Server_Side_Request_Forgery_Prevention, Secrets_Management) at https://cheatsheetseries.owasp.org/cheatsheets/<Name>_Cheat_Sheet.html; https://cwe.mitre.org/data/definitions/409.html; Bun https://bun.sh/docs/{api/workers,api/spawn,installation,runtime/nodejs-compat}; Blender https://docs.blender.org/manual/en/latest/advanced/scripting/security.html (fetch 403, read via search snippet); https://docs.kernel.org/userspace-api/landlock.html; https://github.com/containers/bubblewrap; Microsoft Learn AppContainer isolation (updated 2025-07-10) and Job Objects (2025-07-16) under learn.microsoft.com/en-us/windows/win32/. OWASP path-traversal page not read (redirect); that advice is secondary. A = assumption.

## 1. Upload checklist
- Extension allowlist, decoded first; reject `:` (NTFS streams), double extensions, NUL.
- Magic bytes plus real parser validation; client Content-Type untrusted.
- Server-generated stored names; canonicalize, assert containment under job root, reject symlinks (A).
- Decompression bombs (CWE-409): OWASP discourages ZIP; else cap entry count, per-entry/total expanded bytes, ratio, nesting with streaming counters. Applies to glTF buffers, Draco, KTX2, embedded images.
- Enforce size on the stream; store outside any served root, least-privilege perms.
- SSRF (external URIs in glTF/MTL, URL import): resolve, check every A/AAAA, connect to the validated IP, no redirects, block loopback/RFC1918/link-local/metadata, egress firewall. Default: forbid external references.

## 2. Sandboxing, honest limits
- Blender: `--background --factory-startup --disable-autoexec`. Insufficient: Register-on-start text blocks and Freestyle still run scripts; Python is unrestricted. Accept glTF/OBJ via fixed import script; never raw .blend from untrusted users (A).
- Linux: bubblewrap (namespaces, no-net, ro-bind, seccomp; a toolkit, protection depends on your arguments) plus Landlock (5.13+, unprivileged; docs: not a complete sandbox) plus cgroups. Kernel bugs escape; use gVisor/microVM for public tier (A).
- Windows: Job Object (memory, process limits, kill-on-close; limits, not isolation) plus AppContainer (file/network isolation; Blender compatibility untested, A). VM for strongest isolation.
- macOS: no supported CLI sandbox. `sandbox-exec` works but is deprecated and may change between releases (secondary sources; Apple doc not found). Realistic: dedicated low-privilege user, scrubbed env, rlimits, timeouts (A). Dev only; no public untrusted parsing on macOS.
- Always parse in a separate subprocess, never the server or a Worker thread.

## 3. Job state machine
`received -> validated -> queued -> running -> succeeded | failed | cancelled`; plus `retry_wait`, `expired`.
- Atomic `job.json` (temp, fsync, rename) with version counter; enforced transition table; terminal states immutable.
- Idempotency: `Idempotency-Key` + user + content hash gives one job id; same key, different payload gives 409. Stages write `stage-N.tmp/`, then rename; resume skips stages whose manifest hash matches.
- Resume: boot sweep returns stale-heartbeat `running` jobs to `queued` (attempt+1) after killing orphan trees.
- Cancel: `cancel_requested` polled by Workers; subprocess SIGTERM, grace, SIGKILL (Windows: TerminateJobObject). Bun spawn supports `timeout`, `killSignal`, AbortSignal.
- Retry only infrastructure faults (crash, OOM, timeout once), max 3, backoff; never validation/parser rejections.

## 4. Quotas and timeouts (A, tune by profiling)
Per user: 2 concurrent jobs, daily jobs, storage cap, upload 100 MB, expanded 1 GB, triangle/pixel caps. Timeouts: validate 30 s, Blender 10 min, simulation by step budget. Global queue depth, 429 + Retry-After; 2 heavy jobs on the 16 GB box.

## 5. Secrets, retention, training
- No secrets in repo/images; env vars last resort; allowlisted child env (Blender gets none); short-lived scoped credentials, rotation, access audit, no secrets in logs (OWASP Secrets).
- A: retain uploads/outputs 30 days, deletion endpoint, logs carry IDs not content. No training on user content by default; third-party model APIs need no-training/zero-retention terms; any opt-in is per-asset and revocable.

## 6. Before multi-user/public
Authn/authz with per-object ownership; tenant-scoped paths; TLS, CSRF/CORS, rate limits; parsers in disposable no-network containers/microVMs; Postgres queue (`SKIP LOCKED`), object storage with expiring presigned URLs; malware scan/CDR; GPU workers with signed job tokens and egress deny; secrets manager; audit log; abuse handling.

## 7. Bun limits
- Worker docs: "still experimental, particularly for terminating". `terminate()` cannot interrupt tight sync loops (https://github.com/oven-sh/bun/issues/4134) and once hung on dead workers (https://github.com/oven-sh/bun/issues/11377; current status unverified). `resourceLimits` ignored, so no worker memory cap; hard-kill needs a process.
- Messages sent before `onmessage` is set are dropped.
- Spawn: `maxBuffer` is spawnSync-only; `cgroup` Linux-only; stderr defaults to inherit. `child_process`/`worker_threads` partially implemented.
- Support: Windows 10 1809+ (x64/ARM64), macOS 13+, Linux kernel 5.6+ recommended. Use `path`, argv arrays, no POSIX-signal assumptions on Windows (A).

---
bump: patch
type: Fixed
---

- **Status polls no longer hold the connection past the ingress ceiling.**
  Without a background worker, a `squad_status` poll that claimed a run drove
  the whole advisory pipeline inside the request. Long stages (for example on
  the Copilot runtime) kept it open past the 240-second Azure Container Apps
  ingress limit, which Cowork reported as "Connector unreachable". The poll now
  waits up to 30 seconds, then answers `run_already_in_flight` while the run
  continues in the same process; later polls report it in flight and then
  return the stored result. An in-process guard prevents a second drive even
  if the claim lease lapses. Worker deployments are unchanged.

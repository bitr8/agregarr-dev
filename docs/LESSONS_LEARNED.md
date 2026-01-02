# Lessons Learned

## Security

### 2026-01-02: Error message sanitization approach
- **Issue:** Blacklist approach for sensitive patterns is too permissive
- **Solution:** Use whitelist approach - only show messages matching known-safe patterns
- **Pattern:** `SAFE_MESSAGE_PATTERNS` for allowed messages, `SENSITIVE_PATTERNS` for always-masked

### 2026-01-02: Streaming size enforcement
- **Issue:** `res.text()` buffers entire response before size check - ineffective for large payloads
- **Solution:** Use `ReadableStream` with running byte counter, abort immediately when limit exceeded
- **Code pattern:**
  ```typescript
  const reader = res.body?.getReader();
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.length;
    if (totalBytes > MAX_SIZE) { controller.abort(); throw new Error('Too large'); }
  }
  ```

### 2026-01-02: Symlink escape in path validation
- **Issue:** `path.resolve()` doesn't follow symlinks - attacker can create symlink inside allowed root pointing outside
- **Solution:** Use `fs.realpath()` to resolve symlinks before containment check
- **Code pattern:**
  ```typescript
  const realPath = await fs.realpath(targetPath);
  const realRoot = await fs.realpath(libraryRoot);
  if (!realPath.startsWith(realRoot + path.sep)) throw new Error('Path traversal');
  ```

## Code Review

### 2026-01-02: Multi-AI review catches different issues
- Claude found initial 6 critical issues
- Codex found 4 additional issues in the fixes:
  - Missing import (TypeScript would catch)
  - Size enforcement ineffective (logic issue)
  - Symlink escape (security gap)
  - API contract change (compatibility issue)
- **Takeaway:** Run multiple AI reviews for security-critical code

## API Design

### 2026-01-02: Always include optional fields for compatibility
- **Issue:** Conditionally omitting `message` field broke client expectations
- **Solution:** Always include `message` field even if same as `error`
- **Rationale:** Clients may `response.message` without null check

# ⚠️ Important Build Instructions

## Always build with `--dev` to preserve your `package.json`

```bash
npm run build -- --dev
```

### Why `--dev` is Required

The `--dev` flag is **critical** because:

- **Preserves `package.json`**: Without `--dev`, the build process may overwrite or modify your `package.json` file
- **Development mode**: Keeps the build configuration in development mode for active development
- **Prevents data loss**: Protects your package configuration and dependencies

### ⛔ Never Run

```bash
# DON'T DO THIS
npm run build
```

This can corrupt or overwrite your `package.json` and cause dependency issues.

### Quick Reference

| Command | Result |
|---------|--------|
| `npm run build -- --dev` | ✅ Safe, preserves `package.json` |
| `npm run build` | ❌ Dangerous, may overwrite `package.json` |

### Additional Notes

- Always ensure `--dev` flag is included when building locally
- This applies to all development builds
- For production builds, follow the dedicated production build documentation

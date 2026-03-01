# Performance Optimization Learnings

- **RegExp Hoisting**: Hoisting `new RegExp(...)` out of loops when the pattern is constant can yield significant performance improvements (observed ~50% in micro-benchmark).
- **TypeScript**: When updating internal helper functions, ensure all call sites are updated to match the new signature.
- **Verification**: In environments where full test suites cannot run due to missing dependencies, creating standalone micro-benchmarks or verification scripts is a viable alternative to ensure correctness and performance gains.

/// <reference types="vite/client" />

// Side-effect CSS imports (e.g. `import './styles.css'`) carry no types; Vite
// handles them at build time. This ambient declaration satisfies tsc.
declare module '*.css';

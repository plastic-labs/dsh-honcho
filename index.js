// Committed runtime entry.
//
// The compiled output in lib/ is a build artifact and is not checked in, but
// catalogs that verify a plugin from its git tree (dsh.pub reads `main` from
// package.json and requires it to be a committed file) need an entry that
// exists in the repository. This shim is that entry; it forwards to the build.
export * from "./lib/index.js";

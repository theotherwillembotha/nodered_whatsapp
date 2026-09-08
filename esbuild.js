const esbuild = require('esbuild');
const path = require('path');

// Packages that must remain as require() calls at runtime in the container.
const external = [
    // Real Node-RED runtime dep — installed in the container
    'node-red',
    // Plugincore is a peer dep — volume-mounted in Docker, or installed via npm dependencies.
    '@theotherwillembotha/node-red-plugincore',
    // plugincore build-time deps — lazy require()s, only needed during node generation
    'jsdom',
    'js-beautify',
    'markdown-it',
    // Heavy / native / WASM deps — must be installed in the container via package.json dependencies
    'baileys',      // native crypto deps (libsignal, etc.)
    'sql.js',       // SQLite compiled to WASM — cannot be bundled by esbuild
    'typeorm',      // large ORM with optional native drivers
];

const sharedConfig = {
    bundle: true,
    platform: 'node',
    target: 'node18',
    external,
    format: 'cjs',
    // Nodes.js does require("@theotherwillembotha/node-red-whatsapp") (self-reference).
    // Alias it to the local build output so esbuild can bundle it inline.
    alias: {
        '@theotherwillembotha/node-red-whatsapp': path.resolve('./build/index.js'),
    },
};

async function build() {
    await esbuild.build({
        ...sharedConfig,
        entryPoints: ['build/Nodes.js'],
        outfile: 'build/Nodes.js',
        allowOverwrite: true,
    });
    console.log('Bundled Nodes.js');

    await esbuild.build({
        ...sharedConfig,
        entryPoints: ['build/Plugins.js'],
        outfile: 'build/Plugins.js',
        allowOverwrite: true,
    });
    console.log('Bundled Plugins.js');
}

build().catch(err => {
    console.error(err);
    process.exit(1);
});

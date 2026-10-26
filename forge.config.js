module.exports = {
  packagerConfig: {
    asar: { unpack: '**/*.node', unpackDir: 'node_modules/better-sqlite3' },
    extraResource: ['default-cloud-config.json'],
    ignore: (file) => {
      if (!file) return false;
      const isViteOutput = file === '/.vite' || file.startsWith('/.vite/');
      const isNodeModulesRoot = file === '/node_modules';
      const isSqliteRuntime = [
        '/node_modules/better-sqlite3',
        '/node_modules/node-addon-api',
      ].some((path) => file === path || file.startsWith(`${path}/`));
      return !isViteOutput && !isNodeModulesRoot && !isSqliteRuntime;
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: { name: 'Larp', authors: 'Larp contributors' },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    {
      name: '@electron-forge/plugin-vite',
      config: {
        build: [
          { entry: 'src/main.ts', config: 'vite.main.config.ts' },
          { entry: 'src/preload.ts', config: 'vite.preload.config.ts' },
        ],
        renderer: [
          { name: 'main_window', config: 'vite.renderer.config.ts' },
        ],
      },
    },
  ],
};

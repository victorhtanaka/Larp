const path = require('node:path');
const appIcon = path.resolve(__dirname, 'src/assets/larp-icon.ico');
const fontLicense = path.resolve(__dirname, 'src/assets/fonts/OFL.txt');

module.exports = {
  packagerConfig: {
    icon: appIcon,
    asar: { unpack: '**/*.node' },
    extraResource: ['default-cloud-config.json', appIcon, fontLicense, 'native/larp-core/dist/larp_core.node'],
    ignore: (file) => {
      if (!file) return false;
      const isViteOutput = file === '/.vite' || file.startsWith('/.vite/');
      const isNodeModulesRoot = file === '/node_modules';
      return !isViteOutput && !isNodeModulesRoot;
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: { name: 'Larp', authors: 'Larp contributors', setupIcon: appIcon },
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
          { entry: 'src/updater-preload.ts', config: 'vite.preload.config.ts' },
        ],
        renderer: [
          { name: 'main_window', config: 'vite.renderer.config.ts' },
          { name: 'updater_window', config: 'vite.updater.config.ts' },
        ],
      },
    },
  ],
};

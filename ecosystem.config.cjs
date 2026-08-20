module.exports = {
  apps: [
    {
      name: 'lorcana-fandb',
      script: 'npx',
      // D1 バインディングは wrangler.jsonc の d1_databases から解決される。
      // --local により .wrangler/state/v3/d1 のローカル SQLite を使用。
      args: 'wrangler pages dev dist --local --ip 0.0.0.0 --port 3000',
      cwd: '/home/user/webapp',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
    },
  ],
};

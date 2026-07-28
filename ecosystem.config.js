module.exports = {
  apps: [
    {
      name: 'algobot',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      // Logs
      error_file: './data/logs/error.log',
      out_file: './data/logs/output.log',
      log_file: './data/logs/combined.log',
      time: true,
      // Graceful shutdown
      kill_timeout: 10000,
      listen_timeout: 8000,
      // Restart policy
      exp_backoff_restart_delay: 1000,
      max_restarts: 50,
      min_uptime: '10s'
    }
  ]
};

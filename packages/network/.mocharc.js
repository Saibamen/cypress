module.exports = {
  spec: [
    'test/unit/**/*.ts',
    'test/integration/**/*.ts'
  ],
  require: '../web-config/node-register',
  timeout: 10000,
  recursive: true
} 
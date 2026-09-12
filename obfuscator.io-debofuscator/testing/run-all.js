(async () => {
  require('./regression');
  require('./vm-recovery');
  require('./vm-bytecode');
  require('./vm-cfg');
  require('./invalid-input');
  require('./recovered-shapes');
  require('./beautify');
  await require('./large-regression');
  require('./cli-output');
  require('./sample-suite');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

const { exec } = require('child_process');

exec('git status', (err, stdout, stderr) => {
  if (err) {
    console.error(`Error: ${err.message}`);
    return;
  }
  console.log('--- GIT STATUS ---');
  console.log(stdout);
});

exec('git branch -a', (err, stdout, stderr) => {
    if (err) {
      console.error(`Error: ${err.message}`);
      return;
    }
    console.log('--- GIT BRANCHES ---');
    console.log(stdout);
});

exec('git remote -v', (err, stdout, stderr) => {
    if (err) {
      console.error(`Error: ${err.message}`);
      return;
    }
    console.log('--- GIT REMOTES ---');
    console.log(stdout);
});
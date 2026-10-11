import {hashPassword, random} from './crypto.mjs';
if (process.argv[2] === 'key') process.stdout.write(random() + '\n');
else if (process.argv[2] === 'password') {
  let password = '';
  for await (const chunk of process.stdin) {password += chunk; if (password.length > 1026) throw new Error('Password too long');}
  process.stdout.write(await hashPassword(password.replace(/\r?\n$/, '')) + '\n');
} else throw new Error('Usage: node credentials.mjs key|password');

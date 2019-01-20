# counters


## Deploy REST on chmura.org
* `source ~/.bashrc`
* `nvm use`
* `npm ci`
* `prisma generate`
* `forever start -c "npx ts-node" index.ts` (if not started already)
# counters

## Deploy REST on vercel

## Setup
On https://vercel.com/mieszko4/counters/:
* Set up env variable `DATABASE_URL` to point to Heroku's DB (`DATABASE_URL` should include `?schema=default$default`)
* Set up DNS https://counters.chmura.org/
* Then run `vercel login`

## Deployment
* Run `npm run deploy`
## Deploy REST on chmura.org (deprecated)
DB is hosted on heroku - change .env before running the commands

* `source ~/.bashrc`
* `nvm use`
* `npm ci`
* `prisma generate`
* `npx forever start -c "npx ts-node" index.ts` (if not started already)
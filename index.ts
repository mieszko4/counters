import { prisma } from './generated/prisma-client'
import pMap from 'p-map';
const express = require('express')
const bodyParser = require('body-parser')

const app = express()
app.use(bodyParser.json())

// wrapper for catching async errors
const wrap = fn => (...args) => fn(...args).catch(args[2])

const getPoll = async (name) => {
  const poll = await prisma.poll({ name })
  const answers = await prisma.poll({ name }).answers();

  if (!poll) {
    return null;
  }

  const processedAnswers = await pMap(answers, async ({ name, id }) => {
    const positiveCount = await prisma.votesConnection({
      where: {
        value_gt: 0,
        answer: { id }
      }
    }).aggregate().count()
    const negativeCount = await prisma.votesConnection({
      where: {
        value_lt: 0,
        answer: { id }
      }
    }).aggregate().count()

    return {
      answer: name,
      counter: positiveCount - negativeCount
    }
  });
  
  // TODO use aggreage value when available - https://github.com/prisma/prisma/issues/1312

  return {
    question: poll.question,
    published_at: poll.createdAt,
    details: {
      answers: processedAnswers
    }
  }
};

const version = 'v2';

app.get(`/${version}/polls`, wrap(async (req, res) => {
  const polls = await prisma.polls()
  res.json({
    polls: polls.map(poll => ({
      name: poll.name,
      question: poll.question
    }))
  })
}))

app.get(`/${version}/polls/:pollName`, wrap(async (req, res) => {
  const { pollName } = req.params
  const poll = await getPoll(pollName);

  if (!poll) {
    return res.status(404).json({});
  }

  res.json(poll)
}))

app.post(`/${version}/polls`, wrap(async (req, res) => {
  const { body } = req;
  const newPoll = await prisma.createPoll({
    name: body.name,
    question: body.question,
    answers: {
      create: body.answers.map(answer => ({
        name: answer
      }))
    }
  })

  const poll = await getPoll(newPoll.name)
  res.json(poll)
}))

app.post(`/${version}/polls/:pollName/vote`, wrap(async (req, res) => {
  const { pollName } = req.params
  const { body } = req;

  const answers = await prisma.poll({ name: pollName }).answers()

  // verify
  body.answers.forEach(({ answer, counter }) => {
    if (!answers.find(a => a.name === answer)) {
      return res.status(400).json({ message: `answer ${answer} does not exist in poll ${pollName}` });
    }

    if (counter !== -1 && counter !== 1) {
      return res.status(400).json({ message: `counter ${counter} for answer ${answer} can be eithe 1 or -1` });
    }
  })

  await pMap(body.answers, async ({ answer, counter, validTill }) => {
    const answerId = answers.find(a => a.name === answer).id;

    await prisma.createVote({
      value: counter,
      validUntil: validTill,
      answer: {
        connect: {
          id: answerId
        }
      }
    })
  });

  const poll = await getPoll(pollName)
  res.json(poll)
}))

app.post(`/${version}/polls/:pollName/reset`, wrap(async (req, res) => {
  const { pollName } = req.params
  const { body } = req;

  await prisma.updateManyVotes({
    data: { value: 0 },
    where: {
      answer: {
        poll: { name: pollName },
        name_in: body.answers.map(({ answer }) => answer)
      }
    }
  });

  const poll = await getPoll(pollName)
  res.json(poll)
}))

app.listen(3001, () => console.log('Server is running on http://localhost:3001'))


// reset invalid votes
console.log('Running cron job!');
const everyMinutes = 5;
setInterval(async () => {
  const result = await prisma.updateManyVotes({
    data: { value: 0 },
    where: {
      value_not: 0,
      validUntil_lt: (new Date()).toISOString()
    }
  });
  console.log(`Cleaned up ${result.count} passed votes`);
}, everyMinutes * 60 * 1000);
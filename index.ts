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

  return {
    question: poll.question,
    published_at: poll.createdAt,
    details: {
      answers: answers.map(answer => ({
        answer: answer.name,
        counter: answer.count
      }))
    }
  }
};

const version = 'v1';

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
  body.answers.forEach(({ answer }) => {
    if (!answers.find(a => a.name === answer)) {
      return res.status(400).json({ message: `answer ${answer} does not exist in poll ${pollName}` });
    }
  })

  await pMap(body.answers, async ({ answer, counter }) => {
    const answerId = answers.find(a => a.name === answer).id;

    const oldAnswer = await prisma.answer({ id: answerId });
    await prisma.updateAnswer(
      {
        where: { id: answerId },
        data: { count: oldAnswer.count + counter },
      },
    );
  });

  const poll = await getPoll(pollName)
  res.json(poll)
}))

app.listen(3001, () => console.log('Server is running on http://localhost:3001'))

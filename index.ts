import { prisma } from './generated/prisma-client'
const express = require('express')
const bodyParser = require('body-parser')

const app = express()

app.use(bodyParser.json())

app.get(`/polls`, async (req, res) => {
  const polls = await prisma.polls()
  res.json({
    polls: polls.map(poll => ({
      name: poll.name,
      question: poll.question
    }))
  })
})

app.get('/poll/:pollName', async (req, res) => {
  const { pollName } = req.params
  const poll = await prisma.poll({ name: pollName })
  const answers = await prisma.poll({ name: pollName }).answers();

  if (!poll) {
    return res.status(404).json({});
  }

  res.json({
    question: poll.question,
    name: poll.name,
    published_at: poll.createdAt,
    votes: {
      counters: answers.map(answer => ({
        counter: answer.name,
        votes: answer.count
      }))
    }
  })
})

app.listen(3000, () => console.log('Server is running on http://localhost:3000'))

import { prisma } from './generated/prisma-client'
const express = require('express')
const bodyParser = require('body-parser')

const app = express()

app.use(bodyParser.json())

app.get(`/polls`, async (req, res) => {
  const publishedPosts = await prisma.polls()
  res.json(publishedPosts)
})

app.get('/poll/:pollId', async (req, res) => {
  const { pollId } = req.params
  const post = await prisma.poll({ id: pollId })
  const answers = await prisma.poll({ id: pollId }).answers();
  res.json({
    ...post,
    answers
  })
})

app.listen(3000, () => console.log('Server is running on http://localhost:3000'))

import { prisma } from './generated/prisma-client'
import { groupBy, flatten } from 'lodash'
import pMap from 'p-map';
const express = require('express')
const bodyParser = require('body-parser')

const app = express()
app.use(bodyParser.json())

// wrapper for catching async errors
const wrap = fn => (...args) => fn(...args).catch(args[2])

const cleanExpiredVotes = async () => {
  const result = await prisma.updateManyVotes({
    data: { isInvalid: true },
    where: {
      isInvalid: false,
      validUntil_lt: (new Date()).toISOString()
    }
  });
  console.log(`Cleaned up ${result.count} passed votes`);
}

const getPoll = async (name) => {
  const poll = await prisma.poll({ name })
  const answers = await prisma.poll({ name }).answers();
  
  if (!poll) {
    return null;
  }

  await cleanExpiredVotes();
  const processedAnswers = await pMap(answers, async ({ name, id }) => {
    const positiveCount = await prisma.votesConnection({
      where: {
        value_gt: 0,
        isInvalid: false,
        answer: { id }
      }
    }).aggregate().count()
    const negativeCount = await prisma.votesConnection({
      where: {
        value_lt: 0,
        isInvalid: false,
        answer: { id }
      }
    }).aggregate().count()

    return {
      answer: name,
      counter: positiveCount - negativeCount
    }
  });

  return {
    id: poll.id,
    question: poll.question,
    published_at: poll.createdAt,
    details: {
      answers: processedAnswers
    }
  }
};

const getStat = async (name) => {
  const poll = await prisma.poll({ name })
  const answers = await prisma.poll({ name }).answers();

  if (!poll) {
    return null;
  }

  await cleanExpiredVotes();

  // TODO VERY SLOW - use aggreage value when available - https://github.com/prisma/prisma/issues/1312
  const allVoters = await prisma.votes({
    where: {
      answer: {
        poll: {
          name
        }
      },
      uuid_not: null
    }
  });
  const activeVoters = allVoters.filter(voter => !voter.isInvalid)

  const allVotersCount = Object.keys(groupBy(allVoters, 'uuid')).length;
  const activeVotersCount = Object.keys(groupBy(activeVoters, 'uuid')).length;

  return {
    question: poll.question,
    published_at: poll.createdAt,
    details: {
      voters: allVotersCount,
      active_voters: activeVotersCount
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

app.get(`/${version}/polls/:pollName/stat`, wrap(async (req, res) => {
  const { pollName } = req.params
  const stat = await getStat(pollName);

  if (!stat) {
    return res.status(404).json({});
  }

  res.json(stat)
}))

app.post(`/${version}/polls`, wrap(async (req, res) => {
  const { body } = req;

  if (await prisma.poll({ name: body.name })) {
    return res.status(409).json({})
  }

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
  res.status(201).json(poll)
}))

app.get(`/${version}/polls/:pollName/vote`, wrap(async (req, res) => {
  const { pollName } = req.params
  const { UUID } = req.query
  console.log(req.query)

  // TODO use nesting when done https://github.com/prisma/prisma/issues/3668
  const answers = await prisma.poll({ name: pollName }).answers()
  const groupedVotes = await pMap(answers, async (answer) => {
    const votes = await prisma.votes({ where: {
      uuid: UUID,
      answer: {
        id: answer.id
      }
    }});

    return votes.map(vote => ({
      answer: answer.name,
      counter: vote.value,
      validTill: vote.validUntil,
      UUID: vote.uuid
    }));
  })

  res.json({
    answers: flatten(groupedVotes)
  })
}));

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

  await pMap(body.answers, async ({ answer, counter, validTill, UUID }) => {
    const answerId = answers.find(a => a.name === answer).id;

    await prisma.createVote({
      value: counter,
      validUntil: validTill,
      ...(UUID ? { uuid: UUID } : {}),
      answer: {
        connect: {
          id: answerId
        }
      }
    })
  });

  const poll = await getPoll(pollName)
  res.status(201).json(poll)
}))

app.post(`/${version}/polls/:pollName/reset`, wrap(async (req, res) => {
  const { pollName } = req.params
  const { body } = req;

  await prisma.updateManyVotes({
    data: { isInvalid: true },
    where: {
      answer: {
        poll: { name: pollName },
        name_in: body.answers.map(({ answer }) => answer)
      }
    }
  });

  const poll = await getPoll(pollName)
  res.status(201).json(poll)
}))

// params
app.get(`/${version}/polls/:pollName/params/:paramName`, wrap(async (req, res) => {
  const { pollName, paramName } = req.params

  const poll = await getPoll(pollName);
  if (!poll) {
    return res.status(404).json({});
  }
  
  const param = await prisma.param({ key: paramName });
  if (!param) {
    return res.status(404).json({});
  }

  res.json({
    paramName,
    paramValue: param.value,
  })
}))

app.post(`/${version}/polls/:pollName/params`, wrap(async (req, res) => {
  const { pollName } = req.params
  const { body } = req;

  const poll = await getPoll(pollName);
  if (!poll) {
    return res.status(404).json({});
  }

  const paramExists = await prisma.$exists.param({ key: body.paramName });

  let param;
  if (!paramExists) {
    param = await prisma.createParam({
      key: body.paramName,
      value: body.paramValue,
      poll: {
        connect: {
          id: poll.id,
        }
      }
    })
  } else {
    param = await prisma.updateParam({
      where: {
        key: body.paramName,
      },
      data: {
        value: body.paramValue,
        poll: {
          connect: {
            id: poll.id,
          }
        }
      }
    })
  }
  
  res.status(201).json({
    paramName: param.name,
    paramValue: param.value,
  })
}))

app.delete(`/${version}/polls/:pollName/params/:paramName`, wrap(async (req, res) => {
  const { pollName, paramName } = req.params

  const poll = await getPoll(pollName);
  if (!poll) {
    return res.status(404).json({});
  }
  
  const param = await prisma.param({ key: paramName });
  if (!param) {
    return res.status(404).json({});
  }

  await prisma.deleteParam({ key: paramName })

  res.status(204).json({})
}))

app.listen(3001, () => console.log('Server is running on http://localhost:3001'))

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

const getVoters = async (name) => {
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
    voters: allVotersCount,
    active_voters: activeVotersCount,
  }
}

const getPoll = async (name, withStat = false) => {
  const fragment = `
  fragment pollWithAnswers on Poll {
    question
    createdAt
    answers {
      id
      name
    }
  }
  `
  const pollWithAnswers: any = await prisma.poll({ name }).$fragment(fragment);
  if (!pollWithAnswers) {
    return null;
  }

  await cleanExpiredVotes();
  // TODO: https://www.prisma.io/forum/t/query-count-of-relation-on-connection/2349/4
  const processedAnswers = await pMap(pollWithAnswers.answers, async ({ name, id }) => {
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
    question: pollWithAnswers.question,
    published_at: pollWithAnswers.createdAt,
    details: {
      answers: processedAnswers,
    },
    ...withStat && {
      stats: await getVoters(name),
    },
  }
};

const getStat = async (name) => {
  const poll = await prisma.poll({ name })

  if (!poll) {
    return null;
  }

  await cleanExpiredVotes();

  return {
    question: poll.question,
    published_at: poll.createdAt,
    details: await getVoters(name),
  }
};

const version = 'v2';

app.get(`/${version}/polls`, wrap(async (req, res) => {
  const { paramName, paramValue} = req.query;

  const polls = await prisma.polls(paramName || paramValue ? ({
    where: {
      params_some: {
        ...paramName && { key: paramName },
        ...(paramName && paramValue) && { value: paramValue },
      }
    }
  }) : undefined)
  res.json({
    polls: polls.map(poll => ({
      name: poll.name,
      question: poll.question
    }))
  })
}))

app.get(`/${version}/polls/:pollName`, wrap(async (req, res) => {
  const { withStat } = req.query;

  const { pollName } = req.params
  const poll = await getPoll(pollName, withStat === 'true');

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

app.delete(`/${version}/polls/:pollName`, wrap(async (req, res) => {
  const { pollName } = req.params

  const poll = await prisma.poll({ name: pollName });
  if (!poll) {
    return res.status(404).json({});
  }

  await prisma.deletePoll({ name: pollName })

  res.status(204).json({})
}))

// votes
app.get(`/${version}/polls/:pollName/vote`, wrap(async (req, res) => {
  const { pollName } = req.params
  const { UUID, last } = req.query

  if (last && !Number.isInteger(Number(last))) {
    return res.status(400).json({ message: `Parameter ${last} must be an integer` });
  }

  // TODO use nesting when done https://github.com/prisma/prisma/issues/3668
  const answers = await prisma.poll({ name: pollName }).answers()
  const groupedVotes = await pMap(answers, async (answer) => {
    const votes = await prisma.votes({
      where: {
        uuid: UUID,
        answer: {
          id: answer.id
        }
      },
      orderBy: "createdAt_DESC",
      ...(last && { first: Number(last)}),
      first: Number(last)
    });

    return votes.map(vote => ({
      id: vote.id,
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

app.delete(`/${version}/polls/:pollName/vote/:voteId`, wrap(async (req, res) => {
  const { pollName, voteId } = req.params

  const poll = await prisma.poll({ name: pollName });
  if (!poll) {
    return res.status(404).json({});
  }

  const vote = await prisma.vote({ id: voteId });
  if (!vote) {
    return res.status(404).json({});
  }

  await prisma.deleteVote({ id: voteId })

  res.status(204).json({})
}))

// params
app.get(`/${version}/polls/:pollName/params/:paramName`, wrap(async (req, res) => {
  const { pollName, paramName } = req.params

  const poll = await prisma.poll({ name: pollName });
  if (!poll) {
    return res.status(404).json({});
  }
  
  const [param] = await prisma.poll({name: pollName}).params({ where: { key: paramName }});
  if (!param) {
    return res.status(404).json({});
  }

  res.json({
    paramName,
    paramValue: param.value,
  })
}))

app.get(`/${version}/polls/:pollName/params`, wrap(async (req, res) => {
  const { pollName } = req.params

  const poll = await prisma.poll({ name: pollName });
  if (!poll) {
    return res.status(404).json({});
  }
  
  const params = await prisma.poll({ name: pollName }).params();
  res.json({
    params: params.map(param => ({
      paramName: param.key,
      paramValue: param.value,
    }))
  })
}))

app.post(`/${version}/polls/:pollName/params`, wrap(async (req, res) => {
  const { pollName } = req.params
  const { body } = req;
  const { params } = body;

  if (!Array.isArray(params)) {
    return res.status(400).json({ message: 'params is malformed' });
  }

  const poll = await prisma.poll({ name: pollName });
  if (!poll) {
    return res.status(404).json({});
  }

  await pMap(params, async (parameter) => {
    const paramExists = await prisma.$exists.param({ key: parameter.paramName, poll: {
      name: pollName
    } });

    if (!paramExists) {
      await prisma.createParam({
        key: parameter.paramName,
        value: parameter.paramValue,
        poll: {
          connect: {
            name: pollName
          }
        }
      })
    } else {
      await prisma.updateManyParams({
        where: {
          key: parameter.paramName,
          poll: {
            name: pollName
          }
        },
        data: {
          value: parameter.paramValue,
        }
      })
    }
  });

  const newParams = await prisma.poll({ name: pollName }).params();
  res.status(201).json({
    params: newParams.map(param => ({
      paramName: param.key,
      paramValue: param.value,
    }))
  })
}))

app.delete(`/${version}/polls/:pollName/params`, wrap(async (req, res) => {
  const { pollName } = req.params

  const poll = await prisma.poll({ name: pollName });
  if (!poll) {
    return res.status(404).json({});
  }

  await prisma.deleteManyParams({ poll: {
    name: pollName
  }})

  res.status(204).json({})
}))

app.delete(`/${version}/polls/:pollName/params/:paramName`, wrap(async (req, res) => {
  const { pollName, paramName } = req.params

  const poll = await prisma.poll({ name: pollName });
  if (!poll) {
    return res.status(404).json({});
  }
  
  const [param] = await prisma.poll({name: pollName}).params({ where: { key: paramName }});
  if (!param) {
    return res.status(404).json({});
  }

  await prisma.deleteManyParams({ key: paramName, poll: { name: pollName} })

  res.status(204).json({})
}))

app.listen(3001, () => console.log('Server is running on http://localhost:3001'))

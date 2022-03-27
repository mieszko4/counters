import { PrismaClient } from '@prisma/client'
import { groupBy, flatten } from 'lodash'
import pMap from 'p-map';
import express from 'express'
import bodyParser from 'body-parser'
import * as t from 'typed-assert'

const prisma = new PrismaClient()

const app = express()
app.use(bodyParser.json())

// wrapper for catching async errors
const wrap = fn => (...args) => fn(...args).catch(args[2])

const cleanExpiredVotes = async () => {
  const result = await prisma.vote.updateMany({
    data: { isInvalid: true },
    where: {
      isInvalid: false,
      validUntil: {
        lt: (new Date()).toISOString()
      }
    }
  });
  console.log(`Cleaned up ${result.count} passed votes`);
}

const getVoters = async (name) => {
  // TODO VERY SLOW - use aggreage value when available - https://github.com/prisma/prisma/issues/1312
  const allVoters = await prisma.vote.findMany({
    where: {
      answer: {
        poll: {
          name
        }
      },
      uuid: {
        not: null
      }
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
  const pollWithAnswers = await prisma.poll.findUnique({ where: {name}, include: { answers: true }, });
  if (!pollWithAnswers) {
    return null;
  }

  await cleanExpiredVotes();
  // TODO: https://www.prisma.io/forum/t/query-count-of-relation-on-connection/2349/4
  const processedAnswers = await pMap(pollWithAnswers.answers, async ({ name, id }) => {
    const positiveCount = await prisma.vote.count({
      where: {
        value: {
          gt: 0,
        },
        isInvalid: false,
        answer: { id }
      }
    })
    const negativeCount = await prisma.vote.count({
      where: {
        value: {
          lt: 0,
        },
        isInvalid: false,
        answer: { id }
      }
    })

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
  const poll = await prisma.poll.findUnique({where: { name }})

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

  const polls = await prisma.poll.findMany(paramName || paramValue ? ({
    where: {
      params: {some: {
        ...paramName && { key: paramName },
        ...(paramName && paramValue) && { value: paramValue },
      }
    }}
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

  if (await prisma.poll.findUnique({ where: { name: body.name } })) {
    return res.status(409).json({})
  }

  const newPoll = await prisma.poll.create({
    data: {
      name: body.name,
      question: body.question,
      answers: {
        create: body.answers.map(answer => ({
          name: answer
        }))
      }
    },
    select: {
      name: true
    }
  })

  const poll = await getPoll(newPoll.name)
  res.status(201).json(poll)
}))

app.post(`/${version}/polls/:pollName/reset`, wrap(async (req, res) => {
  const { pollName } = req.params
  const { body } = req;

  await prisma.vote.updateMany({
    data: { isInvalid: true },
    where: {
      answer: {
        poll: { name: pollName },
        name: {
          in: body.answers.map(({ answer }) => answer)
        }
      }
    }
  });

  const poll = await getPoll(pollName)
  res.status(201).json(poll)
}))

app.delete(`/${version}/polls/:pollName`, wrap(async (req, res) => {
  const { pollName } = req.params

  const poll = await prisma.poll.findUnique({ where: { name: pollName } });
  if (!poll) {
    return res.status(404).json({});
  }

  await prisma.poll.delete({ where: { name: pollName } })

  res.status(204).json({})
}))

// votes
app.get(`/${version}/polls/:pollName/vote`, wrap(async (req, res) => {
  const { pollName } = req.params
  const { UUID, last, createdAfter, validOn } = req.query

  if (last && !Number.isInteger(Number(last))) {
    return res.status(400).json({ message: `Parameter ${last} must be an integer` });
  }

  // TODO use nesting when done https://github.com/prisma/prisma/issues/3668
  const answers = await prisma.poll.findUnique({ where: { name: pollName } }).answers()
  const groupedVotes = await pMap(answers, async (answer) => {
    const votes = await prisma.vote.findMany({
      where: {
        uuid: UUID,
        ...(createdAfter && { createdAt_gt: createdAfter }),
        ...(validOn && { validUntil_gte: validOn }),
        answer: {
          id: answer.id
        }
      },
      orderBy: {
        createdAt: 'desc',
      },
      ...(last && { take: Number(last)}),
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

  const answers = await prisma.poll.findUnique({ where: { name: pollName } }).answers()

  // verify
  // TODO: verify other body requests
  const bodyAnswers = body.answers
  t.isArray(bodyAnswers)

  const verifiedBodyAnswers = bodyAnswers.map((o: any) => {
    t.isNotUndefined(o)
    const {
      answer,
      counter,
      validTill,
      UUID
    } = o;
    t.isString(answer)
    t.isNumber(counter)

    return {
      answer,
      counter,
      validTill,
      UUID,
    }
  })

  verifiedBodyAnswers.forEach(({ answer, counter }) => {
    if (!answers.find(a => a.name === answer)) {
      return res.status(400).json({ message: `answer ${answer} does not exist in poll ${pollName}` });
    }

    if (counter !== -1 && counter !== 1) {
      return res.status(400).json({ message: `counter ${counter} for answer ${answer} can be eithe 1 or -1` });
    }
  })

  await pMap(verifiedBodyAnswers, async ({ answer, counter, validTill, UUID }) => {
    const answerId = answers.find(a => a.name === answer).id;

    await prisma.vote.create({
      data: {
        value: counter,
        validUntil: validTill,
        ...(UUID ? { uuid: UUID } : {}),
        answer: {
          connect: {
            id: answerId
          }
        }
      }
    })
  });

  const poll = await getPoll(pollName)
  res.status(201).json(poll)
}))

app.delete(`/${version}/polls/:pollName/vote/:voteId`, wrap(async (req, res) => {
  const { pollName, voteId } = req.params

  const poll = await prisma.poll.findUnique({ where: { name: pollName } });
  if (!poll) {
    return res.status(404).json({});
  }

  const vote = await prisma.vote.findUnique({ where: { id: voteId } });
  if (!vote) {
    return res.status(404).json({});
  }

  await prisma.vote.delete({ where: { id: voteId } })

  res.status(204).json({})
}))

// params
app.get(`/${version}/polls/:pollName/params/:paramName`, wrap(async (req, res) => {
  const { pollName, paramName } = req.params

  const poll = await prisma.poll.findUnique({ where: { name: pollName } });
  if (!poll) {
    return res.status(404).json({});
  }
  
  const [param] = await prisma.poll.findUnique({ where: { name: pollName } }).params({ where: { key: paramName }});
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
  const {
    paramName,
    paramNameContains,
    paramNameStartsWith,
    paramNameEndsWith,
    orderBy,
    first,
  } = req.query

  const poll = await prisma.poll.findUnique({ where: { name: pollName } });
  if (!poll) {
    return res.status(404).json({});
  }
  
  const params = await prisma.poll.findUnique({ where: { name: pollName } }).params({
    where: {
      key: {
        equals: paramName,
        contains: paramNameContains,
        startsWith: paramNameStartsWith,
        endsWith: paramNameEndsWith,
      },
    },
    orderBy,
    take: first !== undefined && Number(first),
  });
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

  const poll = await prisma.poll.findUnique({ where: { name: pollName } });
  if (!poll) {
    return res.status(404).json({});
  }

  await pMap(params, async (parameter) => {
    const paramExists = (await prisma.param.count({
      where: {
        key: parameter.paramName,
        poll: {
          name: pollName
        }
      }
    }) > 0);

    if (!paramExists) {
      await prisma.param.create({ data: {
        key: parameter.paramName,
        value: parameter.paramValue,
        poll: {
          connect: {
            name: pollName
          }
        }
      }})
    } else {
      await prisma.param.updateMany({
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

  res.status(204).json({})
}))

app.delete(`/${version}/polls/:pollName/params`, wrap(async (req, res) => {
  const { pollName } = req.params

  const poll = await prisma.poll.findUnique({ where: { name: pollName } });
  if (!poll) {
    return res.status(404).json({});
  }

  await prisma.param.deleteMany({ where: { poll: {
    name: pollName
  }}})

  res.status(204).json({})
}))

app.delete(`/${version}/polls/:pollName/params/:paramName`, wrap(async (req, res) => {
  const { pollName, paramName } = req.params

  const poll = await prisma.poll.findUnique({ where: { name: pollName } });
  if (!poll) {
    return res.status(404).json({});
  }
  
  const [param] = await prisma.poll.findUnique({ where: { name: pollName }}).params({ where: { key: paramName }});
  if (!param) {
    return res.status(404).json({});
  }

  await prisma.param.deleteMany({ where: { key: paramName, poll: { name: pollName } } })

  res.status(204).json({})
}))

export default app


import { prisma } from './generated/prisma-client'
import { create } from 'domain';

async function main() {
  const newUser = await prisma.createUser({
    name: 'Alice',
    email: 'a@test.com',
    posts: {
      create: [
        {
          title: 'Post one'
        },
        {
          title: 'Post two'
        }
      ]
    }
  })
  console.log(`Created new user: ${newUser.name} (ID: ${newUser.id})`)

  const allUsers = await prisma.users()
  console.log(allUsers)

  const allPosts = await prisma.posts()
  console.log(allPosts)
}

main().catch(e => console.error(e))
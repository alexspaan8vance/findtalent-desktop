// Dev helper: clear projects/matches/reveals so the next run hydrates fresh
// (and no lingering 14-day reveal lock). Leaves users/tenants/plans intact.
import { prisma } from '../src/lib/db';

async function main() {
  await prisma.reveal.deleteMany();
  await prisma.match.deleteMany();
  await prisma.savedSearch.deleteMany();
  await prisma.projectPool.deleteMany();
  await prisma.project.deleteMany();
  console.log('cleared projects/pools/matches/reveals/savedSearches');
  await prisma.$disconnect();
}
main();

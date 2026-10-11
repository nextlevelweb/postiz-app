import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { MediaRepository } from '@gitroom/nestjs-libraries/database/prisma/media/media.repository';

// No database: the Prisma delegate is mocked, so these tests pin the query the
// repository sends, which is where the organization boundary lives
const setup = () => {
  const media = {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  };
  const repository = new MediaRepository({
    model: { media },
  } as unknown as PrismaRepository<'media'>);
  return { media, repository };
};

const SELECT = {
  id: true,
  name: true,
  path: true,
  thumbnail: true,
  alt: true,
  status: true,
};

describe('MediaRepository.getMediaByIdForOrganization', () => {
  it('scopes the lookup to the organization and live records', async () => {
    const { media, repository } = setup();
    const row = {
      id: 'media-1',
      name: 'photo.png',
      path: 'https://uploads.example.com/photo.png',
      thumbnail: null as string | null,
      alt: null as string | null,
      status: 'ready',
    };
    media.findFirst.mockResolvedValue(row);

    await expect(
      repository.getMediaByIdForOrganization('org-a', 'media-1')
    ).resolves.toBe(row);
    expect(media.findFirst).toHaveBeenCalledTimes(1);
    expect(media.findFirst).toHaveBeenCalledWith({
      where: { id: 'media-1', organizationId: 'org-a', deletedAt: null },
      select: SELECT,
    });
  });

  it('returns records that are not ready yet, leaving status to the caller', async () => {
    const { media, repository } = setup();
    const row = { ...SELECT, id: 'media-1', status: 'processing' };
    media.findFirst.mockResolvedValue(row);

    await expect(
      repository.getMediaByIdForOrganization('org-a', 'media-1')
    ).resolves.toBe(row);
    expect(media.findFirst.mock.calls[0][0].where).not.toHaveProperty('status');
  });

  // Prisma finds nothing in all three cases: the row belongs to org-b, has a
  // deletedAt, or does not exist. The repository must answer them identically
  it.each([['foreign'], ['deleted'], ['missing']])(
    'returns null for %s media without a second query',
    async () => {
      const { media, repository } = setup();
      media.findFirst.mockResolvedValue(null);

      await expect(
        repository.getMediaByIdForOrganization('org-a', 'media-1')
      ).resolves.toBeNull();
      expect(media.findFirst).toHaveBeenCalledTimes(1);
      expect(media.findFirst).toHaveBeenCalledWith({
        where: { id: 'media-1', organizationId: 'org-a', deletedAt: null },
        select: SELECT,
      });
      expect(media.findUnique).not.toHaveBeenCalled();
      expect(media.findMany).not.toHaveBeenCalled();
      expect(media.count).not.toHaveBeenCalled();
    }
  );

  it('selects only the intended scalar fields', async () => {
    const { media, repository } = setup();
    media.findFirst.mockResolvedValue(null);

    await repository.getMediaByIdForOrganization('org-a', 'media-1');
    const args = media.findFirst.mock.calls[0][0];

    expect(Object.keys(args).sort()).toEqual(['select', 'where']);
    expect(args.select).toEqual(SELECT);
    for (const field of [
      'organization',
      'agencies',
      'userPicture',
      'oauthApps',
      'organizationId',
      'processingError',
      'deletedAt',
    ]) {
      expect(args.select).not.toHaveProperty(field);
    }
  });
});

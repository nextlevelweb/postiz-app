import { ConnectPlatforms } from '@gitroom/frontend/components/connect/connect-platforms';

export const dynamic = 'force-dynamic';

export default async function ConnectPage(props: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ success?: string }>;
}) {
  const params = await props.params;
  const searchParams = await props.searchParams;

  return (
    <ConnectPlatforms
      token={params.token}
      successProvider={searchParams.success}
    />
  );
}

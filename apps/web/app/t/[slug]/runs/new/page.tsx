import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * The old "New run" page (legacy run flow) is retired: a day is planned on Daily dispatch, which
 * gets or creates the plan version of a depot and day under the day lock (review / stabilization
 * PR5). Old links and bookmarks land there.
 */
export default function NewRunPage({ params }: { params: { slug: string } }) {
  redirect(`/t/${params.slug}/dispatch`);
}

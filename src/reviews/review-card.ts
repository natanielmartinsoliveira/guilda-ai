import type { BmCard } from '../sources/businessmap/businessmap.client';
import { repositoryFromLink } from '../sources/businessmap/text';
/**
 * The GitLab merge request a card points to: the first MR link in its repository field, then in
 * its description, on the company's GitLab host. Undefined when the card names none.
 */
export function mergeRequestOfCard(card: BmCard, repositoryField: number, host: string) {
  const field = card.custom_fields?.find((f) => f.field_id === repositoryField)?.value;
  const texts = [typeof field === 'string' ? field : '', card.description ?? ''];
  for (const text of texts)
    for (const [link] of text.matchAll(/https:\/\/[^\s"'<>]+?\/-\/merge_requests\/\d+/g)) {
      const repository = repositoryFromLink(link, host);
      const number = Number(/\/merge_requests\/(\d+)$/.exec(link)?.[1]);
      if (repository && number > 0) return { repository, number, url: link };
    }
  return undefined;
}

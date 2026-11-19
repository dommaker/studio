import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { CHANNEL_ATTACHMENT_SRC_RE } from './attachmentUrl';
import { fetchStreamTicket } from './streamTicket';

interface AttachmentImageProps {
  src: string | undefined;
  alt: string;
  className?: string;
}

/** Async <img> credential exchange keeps long-lived login credentials out of URLs and message history. */
export function AttachmentImage({ src, alt, className }: AttachmentImageProps) {
  const token = useAuthStore((state) => state.token);
  const isAttachment = !!src && CHANNEL_ATTACHMENT_SRC_RE.test(src);
  const [resolvedSrc, setResolvedSrc] = useState(isAttachment && token ? undefined : src);

  useEffect(() => {
    let active = true;
    if (!src || !isAttachment || !token) {
      setResolvedSrc(src);
      return () => { active = false; };
    }
    setResolvedSrc(undefined);
    fetchStreamTicket(src).then((ticket) => {
      if (active) setResolvedSrc(`${src}?token=${encodeURIComponent(ticket)}`);
    }).catch(() => {
      if (active) setResolvedSrc(src);
    });
    return () => { active = false; };
  }, [src, isAttachment, token]);

  return <img src={resolvedSrc} alt={alt} className={className} />;
}

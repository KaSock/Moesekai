"use client";

import { useState } from "react";
import Image from "next/image";
import { resourceImage, type ResourceSnapshot } from "@/lib/moly/catalog";

interface Props {
    snapshot?: ResourceSnapshot;
    image?: string | null;
    pending: boolean;
    fallback: string;
    alt: string;
    width: number;
    height: number;
    priority?: boolean;
}

/** Prefer the published source thumbnail to an unrelated live CDN projection. */
export default function FurnitureThumbnail({ snapshot, image, pending, fallback, alt, width, height, priority = false }: Props) {
    const [failed, setFailed] = useState<string | null>(null);
    // A packed publication names its source thumbnail by content address.
    const src = pending ? undefined : snapshot?.packs && image ? resourceImage(snapshot, image) : fallback;
    if (src && src !== failed) return <Image src={src} alt={alt} width={width} height={height} unoptimized priority={priority}
        loading={priority ? undefined : "lazy"} onError={() => setFailed(src)} />;
    return <span className="workspace-thumbnail-placeholder" aria-hidden="true" data-image-pending={pending}>
        <svg viewBox="0 0 32 32" width="42" height="42" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="m16 3 12 7v13l-12 7-12-7V10l12-7ZM4 10l12 7 12-7M16 17v13" /></svg>
    </span>;
}

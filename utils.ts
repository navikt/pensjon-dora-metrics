

export function findPullReference(comments: string[] | string | undefined | null): number | null {
    if (comments === undefined || comments === null) {
        return null;
    }
    const text = Array.isArray(comments) ? comments.join() : comments;
    return text.match(/#\d+/g)?.map(num => parseInt(num.replace("#", ""))).filter(num => num !== null).pop() || null;
}

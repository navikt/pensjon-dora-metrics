

export function findPullReference(comments: string[] | string) {
    const text = Array.isArray(comments) ? comments.join() : comments;
    return text.match(/#\d+/g)?.map(num => parseInt(num.replace("#", ""))).filter(num => num !== null).pop() || null;
}

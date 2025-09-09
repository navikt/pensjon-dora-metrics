

export function findPullReference(comments: string []) {
    return comments.join().match(/#\d+/g)?.map(num => parseInt(num.replace("#", ""))).filter(num => num !== null).pop() || null;
}



export function findPullReference(comments: string[] | string | undefined | null): number | null {
    if (comments === undefined || comments === null) {
        return null;
    }
    const text = Array.isArray(comments) ? comments.join() : comments;
    return text.match(/#\d+/g)?.map(num => parseInt(num.replace("#", ""))).filter(num => num !== null).pop() || null;
}

export function findJiraReference(comments: string[] | string | undefined | null, jiraProjectKey: string): string | null {
    if (comments === undefined || comments === null) {
        return null;
    }
    const text = Array.isArray(comments) ? comments.join() : comments;
    return text.match(new RegExp(jiraProjectKey + "-\\d+", "g"))?.map(ref => ref.toUpperCase()).filter(ref => ref !== null).pop() || null;
}


export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}



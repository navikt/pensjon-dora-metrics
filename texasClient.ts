

export const getTexasClientCredentialsToken = async (scope: string): Promise<TexasTokenResponse> => {
    const url = process.env.NAIS_TOKEN_ENDPOINT;
    const response = await fetch(url, {
        headers: {
            'Content-Type': 'application/json',
        },
        method: 'POST',
        body: JSON.stringify({
            identity_provider: 'azuread',
            target: scope,
        }),
    });


    if (response.ok) {
        const data = await response.json();
        if (data.error) {
            throw new Error(`Error fetching Texas token: ${data.error} - ${data.error_description}`);
        }
        return data as TexasTokenResponse;
    } else {
        throw new Error(`Failed to fetch Texas token: ${response.status} ${response.statusText}`);
    }
}

type TexasTokenResponse = {
    access_token: string;
    expires_in: number;
    token_type: string;
};

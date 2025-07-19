import { RawPrompt, renderPrompt } from './base/promptElement';

export function ReviewPrompt(): RawPrompt {
    return (
        <RawPrompt>
            You are an expert software engineer. Your task is to review the previous response and provide feedback.
            Please evaluate the response based on the following criteria:
            1.  **Correctness**: Is the code or information provided correct?
            2.  **Clarity**: Is the response easy to understand?
            3.  **Conciseness**: Is the response concise and to the point?
            4.  **Completeness**: Does the response fully address the user's request?
            5.  **Helpfulness**: Is the response helpful and relevant?

            Please provide a summary of your review and suggest improvements if possible.
        </RawPrompt>
    );
}

export async function renderReviewPrompt() {
    return await renderPrompt(ReviewPrompt, {}, {
        // No options needed for now
    });
}

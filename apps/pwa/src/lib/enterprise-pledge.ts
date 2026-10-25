/**
 * Re-export pure enterprise pledge helpers from @beanpool/core.
 * The web and native apps share the exact same pledge eligibility and refusal wording rules.
 */
export {
    isPastDeadline,
    pledgeClosedLine,
    takesPledges,
    PROJECT_DEADLINE_PASSED_WORDS,
    PROJECT_CLOSED_CODE,
    type TakesPledgesInput,
} from '@beanpool/core';

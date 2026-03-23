/** @type {import('tailwindcss').Config} */
declare const _default: {
    content: string[];
    theme: {
        extend: {
            colors: {
                game: {
                    bg: string;
                    surface: string;
                    card: string;
                    border: string;
                    accent: string;
                    'accent-light': string;
                    gold: string;
                    danger: string;
                    success: string;
                };
            };
            animation: {
                'pulse-glow': string;
                'card-flip': string;
                'slide-up': string;
                'fade-in': string;
                'bounce-in': string;
                shake: string;
            };
            keyframes: {
                pulseGlow: {
                    '0%, 100%': {
                        boxShadow: string;
                    };
                    '50%': {
                        boxShadow: string;
                    };
                };
                cardFlip: {
                    '0%': {
                        transform: string;
                    };
                    '50%': {
                        transform: string;
                    };
                    '100%': {
                        transform: string;
                    };
                };
                slideUp: {
                    '0%': {
                        transform: string;
                        opacity: string;
                    };
                    '100%': {
                        transform: string;
                        opacity: string;
                    };
                };
                fadeIn: {
                    '0%': {
                        opacity: string;
                    };
                    '100%': {
                        opacity: string;
                    };
                };
                bounceIn: {
                    '0%': {
                        transform: string;
                        opacity: string;
                    };
                    '100%': {
                        transform: string;
                        opacity: string;
                    };
                };
                shake: {
                    '0%, 100%': {
                        transform: string;
                    };
                    '20%': {
                        transform: string;
                    };
                    '40%': {
                        transform: string;
                    };
                    '60%': {
                        transform: string;
                    };
                    '80%': {
                        transform: string;
                    };
                };
            };
            fontFamily: {
                game: string[];
            };
        };
    };
    plugins: any[];
};
export default _default;

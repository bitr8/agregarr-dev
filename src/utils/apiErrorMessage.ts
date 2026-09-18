import axios from 'axios';

export const apiErrorMessage = (error: unknown, fallback: string): string => {
  if (axios.isAxiosError<{ message?: string; error?: string }>(error)) {
    return (
      error.response?.data?.message || error.response?.data?.error || fallback
    );
  }
  return fallback;
};

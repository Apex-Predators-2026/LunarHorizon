export function LunarHorizonLogo({ color = 'white', variant = 'full', className }: {
  color?: 'black' | 'white'
  variant?: 'full' | 'wordmark'
  className?: string
}) {
  const wordmark = variant === 'wordmark'
  return (
    <img
      className={className}
      src={`${import.meta.env.BASE_URL}lunar-horizon-${wordmark ? 'wordmark' : color}.png`}
      alt="Lunar Horizon Site Navigator"
      width={wordmark ? 2203 : 2700}
      height={wordmark ? 375 : 605}
    />
  )
}

import type { SetInfo, Valued } from '@femlab/registry';
import { useEffect, useState } from 'preact/hooks';
import type { Query } from './SchemaForm';

/** A draft-only pressure-area calculation; pA is not the vector resultant on a curved Set. */
export function PressurePreview({
  pressure,
  on,
  context,
  forceUnit,
  lengthUnit,
  idealisation,
  query,
}: {
  pressure: unknown;
  on: unknown;
  context: string;
  forceUnit: string;
  lengthUnit: string;
  idealisation: string;
  query: Query;
}) {
  const key = JSON.stringify([pressure, on, context, forceUnit, lengthUnit, idealisation]);
  const [reading, setReading] = useState<{ key: string; text: string; bad: boolean } | null>(null);
  const available = typeof on === 'string' && on !== '' && pressure !== undefined && pressure !== null && pressure !== '';
  useEffect(() => {
    if (!available) return;
    let live = true;
    const convert = async (quantity: unknown, to: string): Promise<Valued> => {
      const value = (await query({ query: 'query.convert', quantity, to })) as Valued;
      if (!Number.isFinite(value.value)) throw new Error('The pressure-area calculation is not finite');
      return value;
    };
    void (async () => {
      const [set, pressureSI] = await Promise.all([query({ query: 'query.set', name: on }) as Promise<SetInfo>, convert(pressure, 'Pa')]);
      if (set.kind !== 'face' || set.count === 0) throw new Error('Choose a non-empty face Set');
      if (!set.pressureArea) throw new Error('Loaded face area is unavailable');
      const areaSI = await convert(set.pressureArea, 'm^2');
      if (areaSI.value <= 0) throw new Error('The selected face Set has no positive area');
      const [force, area] = await Promise.all([convert({ value: pressureSI.value * areaSI.value, unit: 'N' }, forceUnit), convert(areaSI, `${lengthUnit}^2`)]);
      if (live)
        setReading({
          key,
          text: `Pressure × area (scalar): ${force.value.toPrecision(4)} ${force.unit} over ${area.value.toPrecision(4)} ${area.unit}${idealisation === 'planeStrain' ? ' · per 1 m out-of-plane depth' : ''}`,
          bad: false,
        });
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : ((error as { cause?: string })?.cause ?? 'Area preview unavailable');
      if (live) setReading({ key, text: message, bad: true });
    });
    return () => {
      live = false;
    };
  }, [key, available, query]);
  if (!available) return null;
  const current = reading?.key === key ? reading : null;
  return (
    <div class={current?.bad ? 'mono echo bad pressure-area' : 'mono echo pressure-area'} role="status">
      {current?.text ?? 'Reading selected face area…'}
    </div>
  );
}

import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

type Endpoint = {
  label: string;
  value: string;
  hint: string;
};

type ServiceEndpointsProps = {
  items: Endpoint[];
  className?: string;
};

export function ServiceEndpoints({ items, className }: ServiceEndpointsProps) {
  return (
    <Card className={cn("gap-0 py-3", className)}>
      <CardContent className="grid gap-3 sm:grid-cols-2 md:grid-cols-5 md:items-stretch">
        {items.map((item, index) => (
          <div key={item.label} className="flex min-w-0 gap-3">
            {index > 0 ? (
              <Separator orientation="vertical" className="hidden self-stretch md:block" />
            ) : null}
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{item.label}</p>
              <p className="mt-1 truncate font-mono text-[13px]" title={item.value}>
                {item.value}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{item.hint}</p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

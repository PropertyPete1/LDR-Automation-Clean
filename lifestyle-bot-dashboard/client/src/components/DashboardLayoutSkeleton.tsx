import { Skeleton } from './ui/skeleton';

export function DashboardLayoutSkeleton() {
  return (
    <div className="min-h-screen bg-[#F8F9FC]">
      {/* Top nav skeleton */}
      <div className="sticky top-0 z-40 w-full bg-white border-b border-[#E4E7EF]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Skeleton className="h-7 w-7 rounded-lg" />
            <Skeleton className="h-4 w-28" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-24 rounded-lg hidden sm:block" />
            <Skeleton className="h-8 w-24 rounded-lg hidden sm:block" />
            <Skeleton className="h-8 w-24 rounded-lg hidden sm:block" />
            <Skeleton className="h-8 w-20 rounded-lg" />
          </div>
        </div>
      </div>

      {/* Main content skeleton */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </main>
    </div>
  );
}

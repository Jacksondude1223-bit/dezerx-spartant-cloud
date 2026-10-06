<?php
namespace SpartanCloud;

use Illuminate\Support\ServiceProvider;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Laravel\Octane\Events\RequestReceived;
use RuntimeException;
use Throwable;

final class RestoreVisitorIp
{
    public function handle(RequestReceived $event): void
    {
        $request = $event->request;
        $ip = $request->headers->get('X-Spartan-Client-IP');
        if (is_string($ip) && filter_var($ip, FILTER_VALIDATE_IP) !== false) {
            $request->server->set('REMOTE_ADDR', $ip);
            $request->headers->set('X-Forwarded-For', $ip);
            $request->headers->set('X-Real-IP', $ip);
            $request->headers->set('CF-Connecting-IP', $ip);
        }
        $request->server->set('HTTPS', 'on');
        $request->server->set('SERVER_PORT', '443');
        $request->headers->set('X-Forwarded-Proto', 'https');
        $request->headers->set('X-Forwarded-Port', '443');
        $request->headers->remove('Forwarded');
        $request->headers->remove('X-Spartan-Ingress-Key');
    }
}

final class SpartanCloudServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        $this->app['events']->listen(RequestReceived::class, RestoreVisitorIp::class);
        $this->app['router']->get('/__cloud_health', function () {
            try {
                if (getenv('CLOUD_ROLE') === 'primary') {
                    DB::select('SELECT 1');
                    if (!Schema::hasTable('migrations')) {
                        throw new RuntimeException('migrations_missing');
                    }
                }
                return response()->json(['status' => 'ready']);
            } catch (Throwable $error) {
                return response()->json(['status' => 'unavailable'], 503);
            }
        });
    }
}

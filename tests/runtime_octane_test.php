<?php
require '/var/www/html/vendor/autoload.php';
require '/usr/local/lib/spartan-cloud/SpartanCloudServiceProvider.php';

use Illuminate\Foundation\Application;
use Illuminate\Http\Request;
use Laravel\Octane\Events\RequestReceived;
use SpartanCloud\RestoreVisitorIp;

$app = new Application('/var/www/html');
$listener = new RestoreVisitorIp;
$previous = null;
foreach (['198.51.100.27', '2001:db8::27', '203.0.113.8', 'bad,chain', null] as $ip) {
    $server = ['REMOTE_ADDR' => '127.0.0.1', 'HTTP_X_FORWARDED_FOR' => '10.0.0.1', 'HTTP_FORWARDED' => 'for=10.0.0.2', 'HTTP_X_SPARTAN_INGRESS_KEY' => 'secret'];
    if ($ip !== null) {
        $server['HTTP_X_SPARTAN_CLIENT_IP'] = $ip;
    }
    $request = Request::create('http://tenant.example/account', 'GET', [], [], [], $server);
    $listener->handle(new RequestReceived($app, $app, $request));
    $expected = $ip !== null && filter_var($ip, FILTER_VALIDATE_IP) !== false ? $ip : '127.0.0.1';
    if ($request->ip() !== $expected || !$request->isSecure() || $request->getPort() !== 443 || $request->headers->has('Forwarded') || $request->headers->has('X-Spartan-Ingress-Key')) {
        throw new RuntimeException('octane_request_isolation_failed');
    }
    if ($previous !== null && $previous->ip() !== $previousIp) {
        throw new RuntimeException('previous_request_mutated');
    }
    $previous = $request;
    $previousIp = $expected;
}
echo "octane_request_isolation_ok\n";

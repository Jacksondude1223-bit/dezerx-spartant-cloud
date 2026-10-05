<?php
header('Content-Type: application/json');
try {
    if (getenv('CLOUD_ROLE') === 'primary') {
        require __DIR__.'/../vendor/autoload.php';
        $app = require __DIR__.'/../bootstrap/app.php';
        $app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
        Illuminate\Support\Facades\DB::select('SELECT 1');
        if (!Illuminate\Support\Facades\Schema::hasTable('migrations')) {
            throw new RuntimeException('migrations_missing');
        }
    }
    echo json_encode(['status' => 'ready']);
} catch (Throwable $error) {
    http_response_code(503);
    echo json_encode(['status' => 'unavailable']);
}

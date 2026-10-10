<?php

$script = '/usr/local/lib/dezerx/sync-env.php';
$file = tempnam(sys_get_temp_dir(), 'spartan-env-');
if ($file === false) {
    throw new RuntimeException('Unable to create environment fixture');
}
$previous = getenv('PRODUCT_ID');
$previousAppKey = getenv('APP_KEY');
putenv('APP_KEY');
try {
    foreach ([
        ["PRODUCT_ID=1\nAPP_KEY=preserved-test-key\n", '9', '9'],
        ["APP_KEY=preserved-test-key\n", '9', '9'],
        ["PRODUCT_ID=1\nAPP_KEY=preserved-test-key\n", null, '1'],
        ["PRODUCT_ID=1\nAPP_KEY=preserved-test-key\n", '5', '5'],
    ] as [$original, $product, $expected]) {
        file_put_contents($file, $original);
        putenv($product === null ? 'PRODUCT_ID' : 'PRODUCT_ID='.$product);
        $output = [];
        exec(escapeshellarg(PHP_BINARY).' -n '.escapeshellarg($script).' '.escapeshellarg($file), $output, $status);
        if ($status !== 0 || !preg_match('/^PRODUCT_ID='.preg_quote($expected, '/').'$/m', file_get_contents($file))) {
            throw new RuntimeException('Product ID synchronization failed');
        }
        if (!str_contains(file_get_contents($file), 'APP_KEY=preserved-test-key')) {
            throw new RuntimeException('Application encryption key changed');
        }
    }
    echo "Runtime product ID synchronization passed\n";
} finally {
    unlink($file);
    putenv($previous === false ? 'PRODUCT_ID' : 'PRODUCT_ID='.$previous);
    putenv($previousAppKey === false ? 'APP_KEY' : 'APP_KEY='.$previousAppKey);
}

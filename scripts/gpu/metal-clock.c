#include <mach/mach_time.h>
#include <stdio.h>
int main(void) { mach_timebase_info_data_t info; if(mach_timebase_info(&info))return 1; printf("%.9f\n",(double)mach_absolute_time()*info.numer/info.denom/1e9); return 0; }
